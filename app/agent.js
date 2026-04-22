const { createClient } = require('@supabase/supabase-js');
const os = require('os');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
require('dotenv').config();

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error("Missing environment variables.");
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const COMPUTER_NAME = os.hostname();

const MAX_LOG_ENTRIES = 100;
const MAX_COMMAND_HISTORY = 50;

/**
 * Logs messages back to the Supabase dashboard
 */
async function logToCloud(message, level = 'info') {
  // Insert new log
  const { data } = await supabase.from('logs').insert({
    message,
    level,
    computer_name: COMPUTER_NAME
  });

  // Prune old logs to keep database size small
  const { data: logs } = await supabase.from('logs').select('id').eq('computer_name', COMPUTER_NAME).order('created_at', { ascending: false });
  if (logs && logs.length > MAX_LOG_ENTRIES) {
    const idsToDelete = logs.slice(MAX_LOG_ENTRIES).map(l => l.id);
    await supabase.from('logs').delete().in('id', idsToDelete);
  }
}

/**
 * Scans a directory and syncs it with the file_structure table
 */
async function scanDirectory(dirPath, foldersOnly = false) {
  try {
    const target = path.resolve(dirPath);
    let entries = await fs.readdir(target, { withFileTypes: true });

    if (foldersOnly) {
      entries = entries.filter(entry => entry.isDirectory());
    }

    const records = entries.map(entry => ({
      name: entry.name,
      path: path.join(target, entry.name),
      is_dir: entry.isDirectory(),
      computer_name: COMPUTER_NAME
    }));

    // 1. Fetch existing database records for this machine to compare
    const { data: dbRecords, error: fetchError } = await supabase
      .from('file_structure')
      .select('id, path')
      .eq('computer_name', COMPUTER_NAME);

    if (fetchError) throw fetchError;

    // 2. Identify records that are immediate children of the target directory
    const dbChildren = (dbRecords || []).filter(r => path.dirname(r.path) === target);
    
    const localPaths = new Set(records.map(r => r.path));
    const dbPathsMap = new Map(dbChildren.map(r => [r.path, r.id]));

    // 3. Find IDs to delete (items in DB but no longer on disk)
    const idsToDelete = dbChildren.filter(r => !localPaths.has(r.path)).map(r => r.id);

    // 4. Find records to insert (items on disk but not in DB)
    const itemsToInsert = records.filter(r => !dbPathsMap.has(r.path));

    if (idsToDelete.length > 0) await supabase.from('file_structure').delete().in('id', idsToDelete);
    if (itemsToInsert.length > 0) await supabase.from('file_structure').insert(itemsToInsert);

    await logToCloud(`Sync complete: ${target}. Added: ${itemsToInsert.length}, Removed: ${idsToDelete.length}`);
  } catch (err) {
    await logToCloud(`Scan error: ${err.message}`, 'error');
  }
}

/**
 * Windows Persistence: Adds the script to the registry to run on startup
 */
function ensurePersistence() {
  if (process.platform === 'win32') {
    const scriptPath = path.resolve(__filename);
    // We use a VBS-style launcher or direct node call. Here is the direct call:
    const regCmd = `reg add "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "RemoteAgent" /t REG_SZ /d "node ${scriptPath}" /f`;
    
    exec(regCmd, (err) => {
      if (err) console.error("Persistence setup failed:", err);
    });
  }
}

/**
 * Command Router
 */
async function handleCommand(payload) {
  const { id, action_type, payload: data } = payload.new;
  await logToCloud(`Executing ${action_type}...`);

  try {
    switch (action_type) {
      case 'RESTART':
        await logToCloud("System rebooting...", "warn");
        exec('shutdown /r /t 5'); // 5-second delay
        break;

      case 'SCAN':
        const targetPath = data?.path || 'C:\\Users';
        await scanDirectory(targetPath, data?.foldersOnly);
        break;

      case 'MKDIR':
        if (!data?.parentPath || !data?.name) throw new Error("Missing parent path or folder name");
        const newFolderPath = path.join(data.parentPath, data.name);
        await fs.mkdir(newFolderPath);
        await logToCloud(`Created folder: ${newFolderPath}`);
        await scanDirectory(data.parentPath);
        break;

      case 'RENAME':
        if (!data?.path || !data?.newName) throw new Error("Missing path or new name");
        const renamedPath = path.join(path.dirname(data.path), data.newName);
        await fs.rename(data.path, renamedPath);
        await logToCloud(`Renamed: ${data.path} -> ${renamedPath}`);
        await scanDirectory(path.dirname(data.path));
        break;

      case 'MOVE':
        if (!data?.path || !data?.newPath) throw new Error("Missing source or target path");
        await fs.rename(data.path, data.newPath);
        await logToCloud(`Moved: ${data.path} -> ${data.newPath}`);
        await scanDirectory(path.dirname(data.path));
        if (path.dirname(data.path) !== path.dirname(data.newPath)) {
          await scanDirectory(path.dirname(data.newPath));
        }
        break;

      case 'DOWNLOAD':
        if (!data?.path) throw new Error("No path provided for download");
        const fileName = path.basename(data.path);
        const fileBuffer = await fs.readFile(data.path);
        
        // Organize storage as computer_name/timestamp_filename
        const storagePath = `${COMPUTER_NAME}/${Date.now()}_${fileName}`;
        
        const { error: uploadError } = await supabase.storage
          .from('downloads')
          .upload(storagePath, fileBuffer);

        if (uploadError) throw uploadError;
        await logToCloud(`File synced to cloud storage: ${storagePath}`);
        break;

      case 'DELETE':
        if (!data?.path) throw new Error("No path provided for deletion");
        await fs.rm(data.path, { recursive: true, force: true });
        await logToCloud(`Deleted: ${data.path}`, "warn");
        // Refresh view after delete
        await scanDirectory(path.dirname(data.path));
        break;

      default:
        await logToCloud(`Unknown command: ${action_type}`, "error");
    }

    // Mark command as completed
    await supabase.from('commands').update({ status: 'completed' }).eq('id', id);

    // Prune old commands
    const { data: history } = await supabase.from('commands').select('id').eq('computer_name', COMPUTER_NAME).order('created_at', { ascending: false });
    if (history && history.length > MAX_COMMAND_HISTORY) {
      const idsToDelete = history.slice(MAX_COMMAND_HISTORY).map(c => c.id);
      await supabase.from('commands').delete().in('id', idsToDelete);
    }
  } catch (error) {
    await logToCloud(`Command failed: ${error.message}`, "error");
    await supabase.from('commands').update({ status: 'failed' }).eq('id', id);
  }
}

async function start() {
  console.log(`Agent started on ${COMPUTER_NAME}`);
  ensurePersistence();
  await logToCloud("Agent Online");

  // Subscribe to commands targeting this specific computer
  supabase
    .channel('remote-cmds')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'commands', filter: `computer_name=eq.${COMPUTER_NAME}` }, handleCommand)
    .subscribe();
}

start();