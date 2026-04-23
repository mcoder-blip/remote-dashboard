"use client";
import { useEffect, useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';
import { Terminal, HardDrive, Search, Trash2, Move, RotateCcw, Folder, FileText, Download, Loader2, Plus, Filter, Monitor, ChevronRight, RefreshCw, RotateCw } from 'lucide-react';

const MAX_LOG_ENTRIES = 100;

export default function Dashboard() {
  const [logs, setLogs] = useState<any[]>([]);
  const [files, setFiles] = useState<any[]>([]);
  const [activeDownloads, setActiveDownloads] = useState<Set<string>>(new Set());
  const [targetHost, setTargetHost] = useState('');
  const [availableHosts, setAvailableHosts] = useState<string[]>([]);
  const [foldersOnly, setFoldersOnly] = useState(false);
  const [isOnline, setIsOnline] = useState(false);
  const [currentPath, setCurrentPath] = useState('C:\\');
  const [lastScanned, setLastScanned] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; file: any } | null>(null);
  
  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const fetchFiles = async () => {
    if (!targetHost) return;
    const { data } = await supabase
      .from('file_structure')
      .select('*')
      .eq('computer_name', targetHost);

    if (data) {
      // Robust path normalization for Windows/Posix mixed environments
      const normalize = (p: string) => {
        if (!p) return '';
        return p.replace(/[\\/]+$/, '').toLowerCase().replace(/\//g, '\\');
      };

      const currentNorm = normalize(currentPath);

      const filtered = data.filter(file => {
        const fileParts = file.path.replace(/\//g, '\\').split('\\');
        fileParts.pop();
        let fileParent = fileParts.join('\\');
        // Handle drive root edge case (e.g. C: needs to be C:\ for normalization)
        if (fileParent.endsWith(':')) fileParent += '\\';
        return normalize(fileParent) === currentNorm;
      });

      // Find the most recent timestamp in the current set of files
      const latest = filtered.reduce((max, f) => {
        const time = new Date(f.created_at).getTime();
        return time > max ? time : max;
      }, 0);

      setLastScanned(latest > 0 ? new Date(latest).toLocaleTimeString() : 'Never');
      setFiles(filtered.sort((a, b) => (b.is_dir ? 1 : 0) - (a.is_dir ? 1 : 0) || a.name.localeCompare(b.name)));
    }
  };

  const fetchLogs = async () => {
    if (!targetHost) return;
    const { data } = await supabase.from('logs')
      .select('*')
      .eq('computer_name', targetHost)
      .order('created_at', { ascending: false }).limit(MAX_LOG_ENTRIES);
    if (data) setLogs(data);
  };

  const fetchHosts = async () => {
    // Discovery: Query the logs table instead of file_structure.
    // The agent logs "Agent Online" immediately on startup, ensuring it appears here.
    const { data } = await supabase.from('logs').select('computer_name');
    if (data) {
      const hosts = Array.from(new Set(data.map(i => i.computer_name)));
      setAvailableHosts(hosts);
      if (hosts.length > 0 && !targetHost) {
        setTargetHost(hosts[0]);
      }
    }
  };

  const checkStatus = () => {
    if (logs.length > 0) {
      const lastLog = logs[0];
      const lastSeen = new Date(lastLog.created_at).getTime();
      const now = new Date().getTime();
      setIsOnline((now - lastSeen) < 5 * 60 * 1000); // 5m window is generous for a 1m heartbeat
    } else {
      setIsOnline(false);
    }
  };

  useEffect(() => {
    fetchHosts();
  }, []); // Only run once on mount to discover available systems

  useEffect(() => {
    if (!targetHost) return;
    
    setFiles([]); // Clear stale data immediately
    setLogs([]);  // Clear stale logs immediately
    fetchFiles();
    fetchLogs();
    setIsOnline(false);

    // Heartbeat check every 30 seconds
    const statusTimer = setInterval(checkStatus, 30000);

    const closeMenu = () => setMenu(null);
    window.addEventListener('click', closeMenu);
    window.addEventListener('contextmenu', closeMenu);

    const channel = supabase
      .channel('schema-db-changes')
      .on('postgres_changes' as const, { event: 'INSERT' as const, schema: 'public', table: 'logs' as const, filter: `computer_name=eq.${targetHost}` }, 
        payload => setLogs(prev => [payload.new, ...prev]))
      .on('postgres_changes' as const, { event: '*' as const, schema: 'public', table: 'file_structure' as const, filter: `computer_name=eq.${targetHost}` }, 
        () => fetchFiles())
      .on('postgres_changes' as const, { event: 'UPDATE' as const, schema: 'public', table: 'commands' as const, filter: `computer_name=eq.${targetHost}` }, 
        payload => {
          const cmd = payload.new as any;
          if (cmd.action_type === 'DOWNLOAD' && (cmd.status === 'completed' || cmd.status === 'failed')) {
            setActiveDownloads(prev => {
              const next = new Set(prev);
              next.delete(cmd.payload?.path);
              return next;
            });
          }
        })
      .subscribe();

    return () => { 
      clearInterval(statusTimer);
      supabase.removeChannel(channel);
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('contextmenu', closeMenu);
    };
  }, [supabase, targetHost, currentPath]); // Re-subscribe when path changes to keep closure fresh

  useEffect(() => {
    checkStatus();
  }, [logs]);

  const handleContextMenu = (e: React.MouseEvent, file: any) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, file });
  };

  const sendCmd = async (type: string, payload: any = {}) => {
    if (type === 'DOWNLOAD' && payload.path) {
      setActiveDownloads(prev => new Set(prev).add(payload.path));
    }
    await supabase.from('commands').insert({ 
      action_type: type, 
      computer_name: targetHost,
      payload,
      status: 'pending' 
    });
  };

  const clearLogs = async () => {
    if (confirm("Are you sure you want to wipe the logs for this system?")) {
      const { error } = await supabase.from('logs').delete().eq('computer_name', targetHost);
      if (error) console.error("Error clearing logs:", error);
      else setLogs([]);
    }
  };

  return (
    <main className="min-h-screen bg-black text-zinc-300 p-4 flex flex-col gap-4 font-mono">
      {/* Top Bar: System Selection */}
      <div className="border border-zinc-800 p-3 bg-zinc-900/50 flex items-center justify-between rounded-sm">
        <div className="flex items-center gap-3">
          <Monitor size={18} className="text-blue-500" />
          <span className="text-xs font-bold uppercase tracking-widest text-zinc-500">Target System:</span>
          <select 
            value={targetHost} 
            onChange={(e) => setTargetHost(e.target.value)}
            className="bg-black border border-zinc-700 text-blue-400 text-xs py-1 px-3 rounded focus:outline-none focus:border-blue-500 cursor-pointer"
          >
            {!targetHost && <option value="">Searching for agents...</option>}
            {availableHosts.map(host => (
              <option key={host} value={host}>{host}</option>
            ))}
          </select>
            {targetHost && (
              <span className={`text-[10px] px-2 py-0.5 rounded ${isOnline ? 'bg-green-900/30 text-green-500' : 'bg-red-900/30 text-red-500'}`}>
                {isOnline ? '● ONLINE' : '○ OFFLINE'}
              </span>
            )}
        </div>
        <div className="text-[10px] text-zinc-600">
          AGENTS_DISCOVERED: {availableHosts.length}
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4 flex-1">
      {/* Col 1: Explorer */}
      <div className="col-span-3 border border-zinc-800 p-4 bg-zinc-900/30">
        {/* Breadcrumbs */}
        <div className="flex items-center gap-1 text-[10px] text-zinc-500 mb-4 overflow-hidden whitespace-nowrap">
          {currentPath.split('\\').map((part, i, arr) => (
            <div key={i} className="flex items-center">
              <span 
                className="hover:text-blue-400 cursor-pointer"
                onClick={() => {
                  let newPath = arr.slice(0, i + 1).join('\\');
                  // Ensure C: becomes C:\ so Windows resolves the root correctly
                  if (newPath.endsWith(':')) newPath += '\\';
                  if (newPath !== currentPath) {
                    setCurrentPath(newPath);
                    sendCmd('SCAN', { path: newPath, foldersOnly });
                  }
                }}
              >{part}</span>
              {i < arr.length - 1 && <ChevronRight size={10} />}
            </div>
          ))}
        </div>
        <div className="flex justify-between items-center mb-4">
          <div className="flex flex-col">
            <h2 className="flex items-center gap-2 text-blue-500 uppercase tracking-tighter"><HardDrive size={16}/> Explorer</h2>
            <span className="text-[9px] text-zinc-600 font-bold ml-6">LAST_SYNC: {lastScanned}</span>
          </div>
          <div className="flex gap-2">
            <button 
              onClick={() => {
                const name = prompt("New folder name:");
                if (name) sendCmd('MKDIR', { parentPath: currentPath, name });
              }} 
              className="hover:text-white transition-colors" 
              title="New Folder"
            >
              <Plus size={14}/>
            </button>
            <button 
              onClick={() => {
                const p = prompt("Path to scan:", currentPath);
                if (p) {
                  setCurrentPath(p);
                  sendCmd('SCAN', { path: p, foldersOnly });
                }
              }} 
              className="hover:text-white transition-colors"
            >
              <Search size={14}/>
            </button>
            <button 
              onClick={() => sendCmd('SCAN', { path: currentPath, foldersOnly })} 
              className="hover:text-white transition-colors"
              title="Refresh Current Directory"
            >
              <RefreshCw size={14}/>
            </button>
            <button 
              onClick={() => {
                if (confirm(`Perform a full resync of ${currentPath}? This will wipe and reload entries.`)) {
                  sendCmd('RESYNC', { path: currentPath, foldersOnly });
                }
              }} 
              className="hover:text-orange-400 transition-colors"
              title="Hard Resync (Wipe & Reload)"
            >
              <RotateCw size={14}/>
            </button>
            <button 
              onClick={() => {
                const nextState = !foldersOnly;
                setFoldersOnly(nextState);
                // Automatically re-scan with the new filter
                sendCmd('SCAN', { path: currentPath, foldersOnly: nextState });
              }}
              className={`transition-colors ${foldersOnly ? 'text-blue-400' : 'text-zinc-500 hover:text-white'}`}
              title={foldersOnly ? "Folders Only Mode (Active)" : "Show All Files"}
            >
              <Filter size={14}/>
            </button>
          </div>
        </div>
        <div className="text-xs space-y-2 opacity-70 overflow-y-auto max-h-[80vh]">
          {files.map((file) => (
            <div 
              key={file.id} 
              onDoubleClick={() => {
                if (file.is_dir) {
                  setCurrentPath(file.path);
                  sendCmd('SCAN', { path: file.path, foldersOnly });
                }
              }}
              onContextMenu={(e) => handleContextMenu(e, file)}
              className="flex items-center justify-between group gap-2 hover:bg-zinc-800 p-1 cursor-default rounded select-none"
            >
              <div className="flex items-center gap-2 overflow-hidden">
                {file.is_dir ? <Folder size={14} className="text-yellow-600"/> : <FileText size={14} className="text-zinc-500"/>}
                <span className="truncate" title={file.is_dir ? `Double-click to scan: ${file.path}` : file.path}>{file.name}</span>
              </div>
              {!file.is_dir && (
                <button 
                  onClick={() => sendCmd('DOWNLOAD', { path: file.path })}
                  disabled={activeDownloads.has(file.path)}
                  className={`${activeDownloads.has(file.path) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} hover:text-blue-400 transition-all disabled:cursor-not-allowed`}
                  title="Upload to Supabase Storage"
                >
                  {activeDownloads.has(file.path) ? (
                    <Loader2 size={14} className="animate-spin text-blue-400" />
                  ) : (
                    <Download size={14}/>
                  )}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Col 2: Center Controls */}
      <div className="col-span-5 border border-zinc-800 flex flex-col bg-zinc-900/30">
        <div className="p-4 border-b border-zinc-800 text-xs font-bold uppercase tracking-tighter">Command Center</div>
        <div className="p-6 grid grid-cols-2 gap-4">
          <button 
            onClick={() => {
              const path = prompt("Full path of item to delete:");
              if (path && confirm(`Permanently delete ${path}?`)) sendCmd('DELETE', { path });
            }} 
            className="p-4 border border-red-900/50 hover:bg-red-900/20 text-red-500 flex flex-col items-center gap-2"
          >
            <Trash2 size={24}/> DELETE
          </button>
          <button onClick={() => sendCmd('RESTART')} className="p-4 border border-orange-900/50 hover:bg-orange-900/20 text-orange-500 flex flex-col items-center gap-2">
            <RotateCcw size={24}/> RESTART
          </button>
          <button 
            onClick={() => {
              const storagePath = prompt("Binary filename in 'updates' bucket (e.g. winxagent.exe):");
              if (storagePath) sendCmd('UPDATE', { storagePath });
            }}
            className="p-4 border border-blue-900/50 hover:bg-blue-900/20 text-blue-500 flex flex-col items-center gap-2"
          >
            <Loader2 size={24}/> UPDATE AGENT
          </button>
          <button 
            onClick={() => {
              const path = prompt("Source Path (Full path of file/folder):");
              const newPath = path ? prompt("Destination Path (Full target path):", path) : null;
              if (path && newPath) sendCmd('MOVE', { path, newPath });
            }}
            className="p-4 border border-blue-900/50 hover:bg-blue-900/20 text-blue-500 flex flex-col items-center gap-2"
          >
            <Move size={24}/> MOVE
          </button>
        </div>
      </div>

      {/* Col 3: Terminal */}
      <div className="col-span-4 border border-zinc-800 p-4 bg-black overflow-hidden flex flex-col">
        <div className="flex justify-between items-center mb-4 text-green-500">
          <h2 className="flex items-center gap-2"><Terminal size={16}/> SYSTEM_LOG</h2>
          <button 
            onClick={clearLogs} 
            className="hover:text-red-500 transition-colors" 
            title="Clear System Logs"
          >
            <Trash2 size={14}/>
          </button>
        </div>
        <div className="flex-1 text-[10px] overflow-y-auto space-y-1">
          {logs.map((log, i) => (
            <div key={i}><span className="text-zinc-600">[{new Date().toLocaleTimeString()}]</span> {log.message}</div>
          ))}
        </div>
      </div>

      {/* Context Menu Overlay */}
      {menu && (
        <div 
          className="fixed bg-zinc-900 border border-zinc-800 shadow-2xl py-1 z-50 text-[11px] min-w-[140px] rounded-md overflow-hidden"
          style={{ top: menu.y, left: menu.x }}
        >
          {menu.file.is_dir && (
            <button 
              onClick={() => sendCmd('RESYNC', { path: menu.file.path, foldersOnly })}
              className="w-full text-left px-3 py-2 hover:bg-zinc-800 flex items-center gap-2 transition-colors text-orange-400"
            >
              <RefreshCw size={14} /> Resync Folder
            </button>
          )}
          <button 
            onClick={() => {
              const newName = prompt("Rename to:", menu.file.name);
              if (newName) sendCmd('RENAME', { path: menu.file.path, newName });
            }}
            className="w-full text-left px-3 py-2 hover:bg-zinc-800 flex items-center gap-2 transition-colors"
          >
            <Search size={14} className="text-zinc-500" /> Rename
          </button>
          <button 
            onClick={() => {
              const newPath = prompt("Move to (Full Path):", menu.file.path);
              if (newPath) sendCmd('MOVE', { path: menu.file.path, newPath });
            }}
            className="w-full text-left px-3 py-2 hover:bg-zinc-800 flex items-center gap-2 transition-colors"
          >
            <Move size={14} className="text-zinc-500" /> Move
          </button>
          <button 
            onClick={() => {
              if (confirm(`Delete ${menu.file.name}?`)) sendCmd('DELETE', { path: menu.file.path });
            }}
            className="w-full text-left px-3 py-2 hover:bg-red-900/20 text-red-500 flex items-center gap-2 transition-colors border-t border-zinc-800 mt-1"
          >
            <Trash2 size={14} /> Delete
          </button>
        </div>
      )}
      </div>
    </main>
  );
}
