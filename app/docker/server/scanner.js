const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const db = require('./db');
const { removeHLS } = require('./hlsgen');

const MV_DIR = process.env.MV_DIR || '/mv';
const MV_NET_DIR = process.env.MV_NET_DIR || '/mv-net';
const VIDEO_EXT = ['.mp4', '.mkv', '.avi', '.flv', '.mov', '.webm', '.mpg'];

function getMVDir() { return MV_DIR; }
function getMVNetDir() { return MV_NET_DIR; }
function getMVRoots() {
  if (!fs.existsSync(MV_DIR)) return [];
  try {
    return fs.readdirSync(MV_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch (e) { return []; }
}
function getMVNetRoots() {
  if (!fs.existsSync(MV_NET_DIR)) return [];
  try {
    return fs.readdirSync(MV_NET_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch (e) { return []; }
}
function getLibraryRoots() { return getMVRoots(); }

function isProblemAudioCodec(codec) {
  if (!codec) return false;
  const c = String(codec).toLowerCase();
  return c.includes('vorbis') || c.includes('opus') || c.includes('wmav2') || c.includes('cook');
}

function isProblemVideoCodec(codec) {
  if (!codec) return false;
  const c = String(codec).toLowerCase();
  return c.includes('mpeg1') || c.includes('mpeg2') || c.includes('mpeg4') || c.includes('mjpeg') || c.includes('msmpeg');
}

function probeDurationAsync(filepath) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filepath
    ], { timeout: 15000 }, (err, stdout) => {
      if (err) resolve(0);
      else {
        const dur = parseFloat(stdout.trim());
        resolve(isNaN(dur) ? 0 : dur);
      }
    });
  });
}

async function ensureProbedOnDemand(songId) {
  try {
    const song = db.prepare('SELECT filepath, audio_tracks FROM songs WHERE id = ?').get(songId);
    if (!song) return 1;
    if (song.audio_tracks !== null && song.audio_tracks !== undefined) return song.audio_tracks;
    const count = probeAudioTracks(song.filepath);
    db.prepare('UPDATE songs SET audio_tracks = ? WHERE id = ?').run(count, songId);
    return count;
  } catch (e) { return 1; }
}

/**
 * 修复：全方位填充与建进 artists 歌手索引表
 */
function syncSongArtists() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS artists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        artist TEXT,
        count INTEGER DEFAULT 1,
        avatar TEXT
      )
    `);

    // 安全增加可能缺失的列
    try {
      const columns = db.prepare("PRAGMA table_info(artists)").all().map(c => c.name);
      if (!columns.includes('name')) db.exec("ALTER TABLE artists ADD COLUMN name TEXT");
      if (!columns.includes('artist')) db.exec("ALTER TABLE artists ADD COLUMN artist TEXT");
      if (!columns.includes('count')) db.exec("ALTER TABLE artists ADD COLUMN count INTEGER DEFAULT 1");
    } catch (e) {}

    // 清空重构歌手索引
    db.exec("DELETE FROM artists");

    const songs = db.prepare('SELECT artist FROM songs WHERE artist IS NOT NULL AND artist != "" AND artist != "未知歌手"').all();
    const artistCountMap = new Map();

    for (const s of songs) {
      if (s.artist) {
        const multi = String(s.artist).split(/[/,&、]/);
        for (const a of multi) {
          const cleanName = a.trim();
          if (cleanName && cleanName !== '未知歌手') {
            artistCountMap.set(cleanName, (artistCountMap.get(cleanName) || 0) + 1);
          }
        }
      }
    }

    const insertArtist = db.prepare('INSERT INTO artists (name, artist, count) VALUES (?, ?, ?)');
    db.transaction(() => {
      for (const [artistName, count] of artistCountMap.entries()) {
        try {
          insertArtist.run(artistName, artistName, count);
        } catch (e) {}
      }
    })();
    console.log(`[SCAN] 歌手表同步成功，共构建 ${artistCountMap.size} 位歌手数据。`);
  } catch (e) {
    console.error('[SCAN] 同步歌手表失败:', e.message);
  }
}

function ensureDbColumns() {
  try {
    const columns = db.prepare("PRAGMA table_info(songs)").all().map(c => c.name);
    if (!columns.includes('language')) db.exec("ALTER TABLE songs ADD COLUMN language TEXT");
    if (!columns.includes('style')) db.exec("ALTER TABLE songs ADD COLUMN style TEXT");
  } catch (e) {
    console.error('检查/更新数据库字段失败:', e.message);
  }
}

const songCsvMap = new Map();

function normalizeKey(str) {
  if (!str) return '';
  return String(str).trim().toLowerCase().replace(/^0+/, '');
}

function parseCsvLine(line) {
  const cleanLine = line.replace(/^\uFEFF/, '').replace(/\r$/, '').trim();
  if (!cleanLine) return [];

  return cleanLine.split(',').map(item => {
    let s = item.trim();
    if (s.startsWith('"') && s.endsWith('"')) {
      s = s.slice(1, -1).trim();
    }
    return s;
  });
}

function loadSongMappingCsv(dirPath) {
  const possibleNames = ['songs_mapping.csv', 'db.csv', 'songs.csv'];
  let csvPath = null;

  for (const name of possibleNames) {
    const p = path.join(dirPath, name);
    if (fs.existsSync(p)) {
      csvPath = p;
      break;
    }
  }

  if (!csvPath) return;

  try {
    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.split(/\r?\n/);
    if (lines.length <= 1) return;

    const header = parseCsvLine(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, ''));

    const idxNumber = header.findIndex(h => ['number', 'songid', 'id', '编号', '歌曲编号'].includes(h));
    const idxTitle = header.findIndex(h => ['title', 'songname', '歌名', '歌曲名', '名字'].includes(h));
    const idxArtist = header.findIndex(h => ['artist', 'singer', '歌手', '演唱者', '原唱'].includes(h));
    const idxLanguage = header.findIndex(h => ['language', 'lang', '语种', '语言'].includes(h));
    const idxStyle = header.findIndex(h => ['style', 'genre', '风格', '分类'].includes(h));
    const idxFilename = header.findIndex(h => ['filename', 'file', '文件名'].includes(h));

    let loadedCount = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.trim()) continue;

      const parts = parseCsvLine(line);
      const songNumber = idxNumber !== -1 && parts[idxNumber] ? parts[idxNumber].trim() : null;
      const filename = idxFilename !== -1 && parts[idxFilename] ? parts[idxFilename].trim() : null;
      const title = idxTitle !== -1 && parts[idxTitle] ? parts[idxTitle].trim() : null;
      const artist = idxArtist !== -1 && parts[idxArtist] ? parts[idxArtist].trim() : null;
      const language = idxLanguage !== -1 && parts[idxLanguage] ? parts[idxLanguage].trim() : null;
      const style = idxStyle !== -1 && parts[idxStyle] ? parts[idxStyle].trim() : null;

      const record = { title, artist, language, style };

      if (songNumber) {
        songCsvMap.set(normalizeKey(songNumber), record);
        songCsvMap.set(songNumber, record);
      }
      if (filename) {
        songCsvMap.set(normalizeKey(filename), record);
        const base = path.basename(filename, path.extname(filename));
        songCsvMap.set(normalizeKey(base), record);
      }
      loadedCount++;
    }
    console.log(`[CSV Engine] 成功从 ${path.basename(csvPath)} 载入 ${loadedCount} 条数据。`);
  } catch (err) {
    console.error(`[CSV Engine] 读取 CSV 失败 (${csvPath}):`, err.message);
  }
}

function probeAudioTracks(filepath) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', filepath
    ], { timeout: 15000 }).toString();
    const count = out.split('\n').map(l => l.trim()).filter(Boolean).length;
    return count > 0 ? count : 1;
  } catch (e) {
    return 1;
  }
}

function listFilesRecursive(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;

  loadSongMappingCsv(dir);

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (!fs.existsSync(full)) continue;
    let isDir;
    try {
      isDir = entry.isDirectory() || fs.statSync(full).isDirectory();
    } catch (e) { continue; }
    if (isDir) {
      results = results.concat(listFilesRecursive(full));
    } else if (VIDEO_EXT.includes(path.extname(entry.name).toLowerCase())) {
      results.push(full);
    }
  }
  return results;
}

function parseFilename(filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const fullName = path.basename(filename);

  let defaultArtist = '未知歌手';
  let defaultTitle = base;
  let extractedId = null;

  const idMatch = base.match(/^(\d+)\s*[-_]?\s*(.*)$/);
  if (idMatch) {
    extractedId = String(idMatch[1]).trim();
    if (idMatch[2]) defaultTitle = idMatch[2].trim();
  }

  if (!idMatch) {
    const sepList = [' - ', '-', '_'];
    for (const sep of sepList) {
      if (base.includes(sep)) {
        const idx = base.indexOf(sep);
        const artist = base.slice(0, idx).trim();
        const title = base.slice(idx + sep.length).trim();
        if (artist && title) {
          defaultArtist = artist;
          defaultTitle = title;
          break;
        }
      }
    }
  }

  const keysToTry = [
    normalizeKey(extractedId),
    normalizeKey(fullName),
    normalizeKey(base),
    extractedId,
    fullName,
    base
  ].filter(Boolean);

  for (const key of keysToTry) {
    if (songCsvMap.has(key)) {
      const csvData = songCsvMap.get(key);
      return {
        artist: csvData.artist || defaultArtist,
        title: csvData.title || defaultTitle,
        language: csvData.language || null,
        style: csvData.style || null
      };
    }
  }

  return { artist: defaultArtist, title: defaultTitle, language: null, style: null };
}

function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

async function scanLibrary() {
  if (!fs.existsSync(MV_DIR)) {
    return { total: 0, added: 0, removed: 0, error: 'MV_DIR_UNAVAILABLE' };
  }

  ensureDbColumns();
  songCsvMap.clear();
  loadSongMappingCsv(MV_DIR);

  const files = listFilesRecursive(MV_DIR);

  const insert = db.prepare(`
    INSERT INTO songs (title, artist, filename, filepath, audio_tracks, language, style)
    VALUES (@title, @artist, @filename, @filepath, @audio_tracks, @language, @style)
    ON CONFLICT(filename) DO UPDATE SET
      title = excluded.title,
      artist = excluded.artist,
      language = excluded.language,
      style = excluded.style,
      audio_tracks = excluded.audio_tracks
  `);

  const existing = db.prepare('SELECT filename FROM songs').all().map(r => r.filename);
  const existingSet = new Set(existing);

  let added = 0;
  for (const f of files) {
    const rel = path.relative(MV_DIR, f);
    const { artist, title, language, style } = parseFilename(f);
    const audio_tracks = probeAudioTracks(f);

    try {
      const r = insert.run({
        title,
        artist,
        filename: rel,
        filepath: f,
        audio_tracks,
        language,
        style
      });
      if (!existingSet.has(rel) && r.changes > 0) added++;
    } catch (e) {
      console.error('曲库扫描-入库失败(' + rel + '):', e.message);
    }
    await yieldToEventLoop();
  }

  syncSongArtists();

  try {
    const pending = db.prepare('SELECT id, filepath FROM songs WHERE audio_tracks IS NULL').all();
    const upd = db.prepare('UPDATE songs SET audio_tracks = ? WHERE id = ?');
    for (const row of pending) {
      try {
        upd.run(probeAudioTracks(row.filepath), row.id);
      } catch (e) {}
      await yieldToEventLoop();
    }
  } catch (e) {}

  let removed = 0;
  try {
    const currentRelSet = new Set(files.map(f => path.relative(MV_DIR, f)));
    const all = db.prepare('SELECT id, filename FROM songs').all();

    const delQueue = db.prepare('DELETE FROM queue WHERE song_id = ?');
    const delHistory = db.prepare('DELETE FROM history WHERE song_id = ?');
    const delFavorites = db.prepare('DELETE FROM favorites WHERE song_id = ?');
    const del = db.prepare('DELETE FROM songs WHERE id = ?');
    const delSongAndRefs = db.transaction((id) => {
      delQueue.run(id);
      delHistory.run(id);
      delFavorites.run(id);
      del.run(id);
    });

    for (const row of all) {
      if (!currentRelSet.has(row.filename)) {
        try {
          delSongAndRefs(row.id);
          removeHLS(row.id);
          removed++;
        } catch (e) {}
      }
    }
  } catch (e) {}

  return { total: files.length, added, removed };
}

module.exports = {
  scanLibrary,
  MV_DIR,
  MV_NET_DIR,
  probeAudioTracks,
  probeDurationAsync,
  ensureProbedOnDemand,
  syncSongArtists,
  isProblemAudioCodec,
  isProblemVideoCodec,
  getMVDir,
  getMVNetDir,
  getMVRoots,
  getMVNetRoots,
  getLibraryRoots
};
