export type JobStatus = "pending" | "running" | "completed" | "failed";

export type TaskKind = "cpu" | "ssh" | "training";

export type TaskStatus =
  | "pending"
  | "queued"
  | "running"
  | "succeeded"
  | "failed";

export interface ProgressCounts {
  done: number;
  total: number;
  failed: number;
}

export interface JobProgress {
  cpu: ProgressCounts;
  ssh: ProgressCounts;
  training: ProgressCounts;
}

export interface JobView {
  id: string;
  userId: string;
  status: JobStatus;
  pipelinesCount: number;
  createdAt: string;
  completedAt: string | null;
  progress: JobProgress;
}
