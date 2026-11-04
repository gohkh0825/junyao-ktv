const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const db = require('./db');
const { removeHLS } = require('./hlsgen');

const MV_DIR = process.env.MV_DIR || '/mv';
const MV_NET_DIR = process.env.MV_NET_DIR || '/mv-net';
const VIDEO_EXT = ['.mp4', '.mkv', '.avi', '.flv', '.mov', '.webm', '.mpg'];

/**
 * ----------------------------------------------------
 * 1. 容器内完整版 index.js 强依赖的全部导出函数 (解决 500 报错)
 * ----------------------------------------------------
 */
function getMVDir() {
  return MV_DIR;
}

function getMVNetDir() {
  return MV_NET_DIR;
}

function getMVRoots() {
  if (!fs.existsSync(MV_DIR)) return [];
  try {
    return fs.readdirSync(MV_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch (e) {
    return [];
  }
}

function getMVNetRoots() {
  if (!fs.existsSync(MV_NET_DIR)) return [];
  try {
    return fs.readdirSync(MV_NET_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch (e) {
    return [];
  }
}

function getLibraryRoots() {
  return getMVRoots();
}

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
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      filepath
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
    if (song.audio_tracks !== null && song.audio_tracks !== undefined) {
      return song.audio_tracks;
    }
    const count = probeAudioTracks(song.filepath);
    db.prepare('UPDATE songs SET audio_tracks = ? WHERE id = ?').run(count, songId);
    return count;
  } catch (e) {
    return 1;
  }
}

function syncSongArtists() {
  try {
    const songs = db.prepare('SELECT DISTINCT artist FROM songs WHERE artist IS NOT NULL AND artist != ""').all();
    const insertArtist = db.prepare('INSERT OR IGNORE INTO artists (name) VALUES (?)');
    db.transaction(() => {
      for (const s of songs) {
        if (s.artist) insertArtist.run(s.artist);
      }
    })();
  } catch (e) {
    // 忽略找不到 artists 表时的静默异常
  }
}

/**
 * ----------------------------------------------------
 * 2. 数据库安全自动扩展
 * ----------------------------------------------------
 */
function ensureDbColumns() {
  try {
    const columns = db.prepare("PRAGMA table_info(songs)").all().map(c => c.name);
    if (!columns.includes('language')) {
      db.exec("ALTER TABLE songs ADD COLUMN language TEXT");
    }
    if (!columns.includes('style')) {
      db.exec("ALTER TABLE songs ADD COLUMN style TEXT");
    }
  } catch (e) {
    console.error('检查/更新数据库字段失败:', e.message);
  }
}

/**
 * ----------------------------------------------------
 * 3. CSV 优先映射解析引擎
 * ----------------------------------------------------
 */
const songCsvMap = new Map();

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

    const header = parseCsvLine(lines[0]).map(h => h.toLowerCase());

    const idxNumber = header.findIndex(h => ['number', 'songid', 'id', '编号'].includes(h));
    const idxTitle = header.findIndex(h => ['title', 'songname', '歌名', '歌曲名'].includes(h));
    const idxArtist = header.findIndex(h => ['artist', 'singer', '歌手', '演唱者'].includes(h));
    const idxLanguage = header.findIndex(h => ['language', 'lang', '语种'].includes(h));
    const idxStyle = header.findIndex(h => ['style', 'genre', '风格'].includes(h));
    const idxFilename = header.findIndex(h => ['filename', 'file', '文件名'].includes(h));

    let loadedCount = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.trim()) continue;

      const parts = parseCsvLine(line);
      const songNumber = idxNumber !== -1 && parts[idxNumber] ? String(parts[idxNumber]).trim() : null;
      const filename = idxFilename !== -1 && parts[idxFilename] ? parts[idxFilename].trim() : null;
      const title = idxTitle !== -1 && parts[idxTitle] ? parts[idxTitle].trim() : null;
      const artist = idxArtist !== -1 && parts[idxArtist] ? parts[idxArtist].trim() : null;
      const language = idxLanguage !== -1 && parts[idxLanguage] ? parts[idxLanguage].trim() : null;
      const style = idxStyle !== -1 && parts[idxStyle] ? parts[idxStyle].trim() : null;

      const record = { title, artist, language, style };

      if (songNumber) {
        songCsvMap.set(songNumber, record);
        songCsvMap.set(String(parseInt(songNumber, 10)), record);
      }
      if (filename) {
        songCsvMap.set(filename, record);
        const base = path.basename(filename, path.extname(filename));
        songCsvMap.set(base, record);
      }
      loadedCount++;
    }
    console.log(`[CSV Engine] 成功从 ${path.basename(csvPath)} 载入 ${loadedCount} 条记录。`);
  } catch (err) {
    console.error(`[CSV Engine] 读取 CSV 失败 (${csvPath}):`, err.message);
  }
}

function probeAudioTracks(filepath) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=index',
      '-of', 'csv=p=0',
      filepath
    ], { timeout: 15000 }).toString();
    const count = out.split('\n').map(l => l.trim()).filter(Boolean).length;
    return count > 0 ? count : 1;
  } catch (e) {
    console.error('ffprobe 音轨检测失败(' + path.basename(filepath) + '):', e.message);
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
    console.error('曲库目录读取失败，已跳过(' + dir + '):', e.message);
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (!fs.existsSync(full)) continue;
    let isDir;
    try {
      isDir = entry.isDirectory() || fs.statSync(full).isDirectory();
    } catch (e) {
      continue;
    }
    if (isDir) {
      results = results.concat(listFilesRecursive(full));
    } else if (VIDEO_EXT.includes(path.extname(entry.name).toLowerCase())) {
      results.push(full);
    }
  }
  return results;
}

function parseFilename(filename) {
  const base = path.basename(filename, path.extname(filename));
  const fullName = path.basename(filename);

  let defaultArtist = '未知歌手';
  let defaultTitle = base;
  let extractedId = null;

  const idMatch = base.match(/^(\d+)\s*[-_]?\s*(.*)$/);
  if (idMatch) {
    extractedId = String(idMatch[1]).trim();
    if (idMatch[2]) {
      defaultTitle = idMatch[2].trim();
    }
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

  const keysToTry = [extractedId, fullName, base].filter(Boolean);
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
    console.error('曲库目录不可访问，已跳过本次扫描以避免误删曲库:', MV_DIR);
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
      console.error('曲库扫描-新增文件入库失败(' + rel + '):', e.message);
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
      } catch (e) {
        console.error('曲库扫描-音轨补全失败(id=' + row.id + '):', e.message);
      }
      await yieldToEventLoop();
    }
  } catch (e) {
    console.error('曲库扫描-音轨补全阶段失败:', e.message);
  }

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
        } catch (e) {
          console.error('曲库扫描-删除已缺失曲目失败(id=' + row.id + '):', e.message);
        }
      }
    }
  } catch (e) {
    console.error('曲库扫描-清理缺失文件阶段失败:', e.message);
  }

  return { total: files.length, added, removed };
}

/**
 * ----------------------------------------------------
 * 4. 导出全套函数 (彻底满足 2000 多行容器内 index.js 的 require)
 * ----------------------------------------------------
 */
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
