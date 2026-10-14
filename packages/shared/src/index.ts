/** flow 共享类型与常量 */

export type Direction = 'in' | 'out';
export type FileStatus = 'scanned' | 'parsing' | 'done' | 'error' | 'needs_review';
export type TxStatus = 'ok' | 'needs_review' | 'fixed';
export type Severity = 'high' | 'medium' | 'low';
export type HitStatus = 'open' | 'confirmed' | 'false_positive';
export type EntityType = 'self' | 'subsidiary' | 'related_party';
export type AccountKind = 'dedicated' | 'general' | 'unknown';

/** 实体状态（对齐 Avalon active/done/archived 三态） */
export type EntityStatus = 'active' | 'done' | 'archived';

/** 业务实体层级：客户（xx 上市公司）→ 融资项目（IPO/再融资/可转债）→ 报告期任务（流水分析） */
export interface Client {
  id: number;
  name: string;
  folderPath: string;
  status: EntityStatus;
  createdAt: string;
  updatedAt: string;
  /** 目录已被移动/删除 */
  dirMissing?: boolean;
}

export interface Project {
  id: number;
  clientId: number;
  name: string;
  folderPath: string;
  status: EntityStatus;
  createdAt: string;
  updatedAt: string;
  dirMissing?: boolean;
}

/** 报告期任务：PDF 输入 / 报告输出的工作单元 */
export interface FlowTask {
  id: number;
  projectId: number;
  name: string;
  folderPath: string;
  status: EntityStatus;
  createdAt: string;
  updatedAt: string;
  dirMissing?: boolean;
}

export interface ClientView extends Client {
  projectCount: number;
  taskCount: number;
  txCount: number;
}

/** 详情接口的客户/项目简要信息（面包屑用） */
export interface ClientBrief {
  id: number;
  name: string;
}

export interface ProjectBrief extends ClientBrief {
  taskCount: number;
}

export interface ProjectView extends Project {
  taskCount: number;
  fileCount: number;
  txCount: number;
}

export interface TaskView extends FlowTask {
  fileCount: number;
  txCount: number;
}

/** 实体创建位置：create = 在 parentPath 下创建名为 name 的目录；use = 直接使用已有目录 */
export type EntityLocation =
  | { kind: 'create'; parentPath: string }
  | { kind: 'use'; dirPath: string };

export interface CreateEntityInput {
  name: string;
  location: EntityLocation;
}

/* ---------- fs（目录选择器，对齐 Avalon fs:list/fs:create-dir 语义） ---------- */

export interface FsRootInfo {
  root: string;
}

export interface FsListing {
  path: string;
  parent: string | null;
  entries: { name: string; path: string }[];
}

export interface FsMkdirInput {
  parent: string;
  name: string;
}

export interface Settings {
  /** vLLM OpenAI 兼容基址，如 http://192.168.1.17:8005/v1 或 https://xxx.heiyu.space/v1 */
  llmBase: string;
  llmModel: string;
  /** 可选：LLM 自定义请求头，如 "Authorization: Bearer sk-xxx" 或 "X-Api-Key: abc" */
  llmExtraHeader: string;
  /** PP-OCRv6 基址，如 http://192.168.1.17:8008 或 https://xxx.heiyu.space */
  ocrBase: string;
  /** 可选：OCR 自定义请求头 */
  ocrExtraHeader: string;
  llmConcurrency: number;
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

export interface BankFile {
  id: number;
  taskId: number;
  relPath: string;
  bank?: string;
  accountNo?: string;
  accountName?: string;
  periodStart?: string;
  periodEnd?: string;
  status: FileStatus;
  txCount: number;
  error?: string;
  updatedAt: string;
}

export interface Transaction {
  id: number;
  fileId: number;
  page: number;
  lineNo: number;
  date?: string;
  summary?: string;
  amount: number;
  direction: Direction;
  balance?: number;
  counterparty?: string;
  counterpartyAccount?: string;
  channel?: string;
  category?: string;
  categorySrc?: 'llm' | 'manual';
  subjectId?: number;
  riskFlags: string[];
  confidence: number;
  rawText?: string;
  status: TxStatus;
}

export interface Subject {
  id: number;
  scope: 'global' | 'project';
  projectId?: number;
  name: string;
  aliases: string[];
  entityType: EntityType;
  accountKind: AccountKind;
  note?: string;
}

export interface RuleDef {
  id: number;
  name: string;
  type: string;
  params: Record<string, unknown>;
  severity: Severity;
  enabled: boolean;
  builtin: boolean;
}

export interface RuleHit {
  id: number;
  ruleId: number;
  transactionId: number;
  detail: string;
  status: HitStatus;
  createdAt: string;
}

export interface DashboardSummary {
  fileCount: number;
  txCount: number;
  inflow: number;
  outflow: number;
  openHits: number;
  byCategory: { category: string; count: number; amount: number }[];
}

/* ---------- 默认配置 ---------- */

export const DEFAULT_SETTINGS: Settings = {
  llmBase: 'http://192.168.1.17:8005/v1',
  llmModel: 'qwen-3.8-27b-uncensored',
  llmExtraHeader: '',
  ocrBase: 'http://192.168.1.17:8008',
  ocrExtraHeader: '',
  llmConcurrency: 2,
};

/** 专户（募集资金）默认分类集 */
export const DEDICATED_CATEGORIES = [
  '项目投入',
  '临时补流',
  '现金管理',
  '手续费',
  '利息',
  '现金管理投资收益',
  '其他',
];

/** 一般户默认分类集 */
export const GENERAL_CATEGORIES = [
  '货款/服务',
  '关联方往来',
  '税费',
  '工资/社保',
  '利息',
  '手续费',
  '其他',
];
