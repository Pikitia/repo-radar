export type CiWatch = {
  id: string;
  repoPath: string;
  branch: string;
  workflowId?: number;
  workflowName?: string;
};

export type CiWatchInput = Omit<CiWatch, "id">;

export type CiWorkflow = { id: number; name: string; path: string; state: string };

export type CiRun = {
  id: number;
  attempt: number;
  workflowName: string;
  title: string;
  number: number;
  branch: string | null;
  commit: string;
  status: string | null;
  conclusion: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  htmlUrl: string;
};

export type CiStep = {
  number: number;
  name: string;
  status: string | null;
  conclusion: string | null;
};

export type CiJob = {
  id: number;
  name: string;
  status: string | null;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  htmlUrl: string;
  steps: CiStep[];
};
