export type PaneType = 'claude' | 'powershell' | 'powershell-admin' | 'local-model' | 'codex' | 'gemini' | 'wsl' | 'cmd' | 'git-bash' | 'custom';
export type PaneColor = '' | 'blue' | 'green' | 'amber' | 'purple' | 'red' | 'teal';
export type SessionStatus = 'idle' | 'starting' | 'running' | 'busy' | 'exited' | 'error';
export interface LocalProfile { id: string; name: string; provider: 'ollama' | 'lmstudio'; endpoint: string; model: string; systemPrompt: string; contextSize: number; temperature: number; }
export interface PaneConfig { id: string; type: PaneType; title: string; cwd: string; command: string; args: string[]; profileId: string; autoStart: boolean; color?: PaneColor; }
export interface GridItem { i: string; x: number; y: number; w: number; h: number; minW?: number; minH?: number; }
export interface Workspace { id: string; name: string; root: string; panes: PaneConfig[]; layout: GridItem[]; locked: boolean; }
export interface AppState { version: 1; activeWorkspaceId: string; workspaces: Workspace[]; profiles: LocalProfile[]; }
export interface SessionEvent { paneId: string; kind: 'data' | 'status'; data?: string; status?: SessionStatus; message?: string; pid?: number; elevated?: boolean; }
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface AppInfo { version: string; platform: string; statePath: string; appElevated: boolean; root: string; }
export interface VaultInfo { path: string; projects: number; notes: number; obsidian: boolean; scannedAt: string; message: string; }
export interface VaultGraph { nodes: { id: string; label: string; project: string; type: string }[]; edges: { from: string; to: string }[]; }
export interface VaultTarget { kind: 'project' | 'obsidian' | 'workspace'; name: string; path: string; }
export interface BridgeApi {
  loadState(): Promise<AppState | null>;
  saveState(state: AppState): Promise<void>;
  appInfo(): Promise<AppInfo>;
  chooseDirectory(): Promise<string | null>;
  exportWorkspace(workspace: Workspace): Promise<boolean>;
  importWorkspace(): Promise<Workspace | null>;
  startSession(pane: PaneConfig, cols: number, rows: number): Promise<void>;
  stopSession(paneId: string): Promise<void>;
  writeSession(paneId: string, data: string): void;
  resizeSession(paneId: string, cols: number, rows: number): void;
  onSessionEvent(callback: (event: SessionEvent) => void): () => void;
  listModels(profile: LocalProfile): Promise<string[]>;
  chat(paneId: string, profile: LocalProfile, messages: ChatMessage[]): Promise<string>;
  cancelChat(paneId: string): Promise<void>;
  vaultInfo(): Promise<VaultInfo>;
  openVault(): Promise<void>;
  showVaultFolder(): Promise<void>;
  vaultGraph(): Promise<VaultGraph>;
  vaultAsk(paneId: string, profile: LocalProfile, question: string): Promise<{ answer: string; notes: string[] }>;
  vaultResolve(name: string, workspaces: { id: string; name: string }[]): Promise<VaultTarget[]>;
  openObsidianVault(path: string): Promise<void>;
}
