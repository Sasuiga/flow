/** flow 共享类型与常量 */

export type Direction = 'in' | 'out';
export type FileStatus = 'scanned' | 'parsing' | 'done' | 'error' | 'needs_review';
export type TxStatus = 'ok' | 'needs_review' | 'fixed';
export type Severity = 'high' | 'medium' | 'low';
export type HitStatus = 'open' | 'confirmed' | 'false_positive';
export type EntityType = 'self' | 'subsidiary' | 'related_party';
export type AccountKind = 'dedicated' | 'general' | 'unknown';

export interface Settings {
  /** vLLM OpenAI 兼容基址，如 http://192.168.1.17:8005/v1 */
  llmBase: string;
  llmModel: string;
  /** PP-OCRv6 基址，如 http://192.168.1.17:8008 */
  ocrBase: string;
  llmConcurrency: number;
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

export interface Project {
  id: number;
  name: string;
  folderPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface BankFile {
  id: number;
  projectId: number;
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
  ocrBase: 'http://192.168.1.17:8008',
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
