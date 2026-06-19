export interface FileBackup {
  path: string;
  originalContent: string | null; // null if the file did not exist before
  originalHash?: string;
}

export interface Checkpoint {
  id: string;
  sessionId: string;
  timestamp: string;
  toolCallId: string;
  backups: FileBackup[];
}
