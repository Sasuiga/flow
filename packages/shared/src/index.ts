/** flow 共享类型与常量 */

export type Direction = 'in' | 'out';
export type FileStatus = 'scanned' | 'parsing' | 'done' | 'error' | 'needs_review';

/** 解析进度一步：wait 未到 / run 进行中 / pause 已暂停 / done 完成 / skip 本文件不需要 / fail 停在这里 */
export type ParseStepState = 'wait' | 'run' | 'pause' | 'done' | 'skip' | 'fail';

export interface ParseStep {
  id: string;
  label: string;
  state: ParseStepState;
  detail?: string;
}
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

/** 任务列表（交易浏览器过滤器/上下文切换器用，带层级名称） */
export interface TaskListItem extends TaskView {
  clientName: string;
  projectName: string;
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

/** Windows 目录选择器里「此电脑」的虚拟路径，列出全部盘符 */
export const FS_DRIVES_PATH = '::drives';

export interface FsRootInfo {
  root: string;
  /** Windows 本机可以列出 C:、D: 等盘符 */
  canListDrives?: boolean;
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

/** 一套可选用的视觉模型。地址、模型名、鉴权可以各自不同。 */
export interface LlmProfile {
  id: string;
  /** 给人看的名字，例如「局域网 Qwen」 */
  name: string;
  base: string;
  model: string;
  extraHeader: string;
}

export interface Settings {
  /** OpenAI 兼容基址，如 http://127.0.0.1:8005/v1 或 https://your-llm.example.com/v1。与默认模型保持一致。 */
  llmBase: string;
  llmModel: string;
  /** 可选：LLM 自定义请求头，如 "Authorization: Bearer sk-xxx" 或 "X-Api-Key: abc" */
  llmExtraHeader: string;
  /** 设置里登记的模型。解析前从这里选。 */
  llmProfiles: LlmProfile[];
  /** 自动解析和分类用的模型 */
  defaultLlmId: string;
  /** OCR 服务基址，如 http://127.0.0.1:8008 或 https://your-ocr.example.com */
  ocrBase: string;
  /** 可选：OCR 自定义请求头 */
  ocrExtraHeader: string;
  llmConcurrency: number;
  /** 解析完成后自动 LLM 批量分类（M4） */
  autoCategorize: boolean;
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
  /** 解析过程；完成后清空。出错时保留，用来看停在哪一步 */
  progress?: ParseStep[];
  /** 上次已读完的页之后，下一页页码。有值时再次解析从这里继续 */
  resumePage?: number;
  /** 这份 PDF 的总页数，和 resumePage 一起用 */
  resumeTotal?: number;
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

/* ---------- 交易浏览器（M2） ---------- */

/** 交易行 + 文件/任务上下文（跨任务浏览用） */
export interface TxRow {
  id: number;
  fileId: number;
  fileName: string;
  taskName: string;
  projectName: string;
  clientName: string;
  bank?: string;
  accountNo?: string;
  /** 这笔流水所属账户的开户主体 */
  holder?: string;
  /** 募投项目，由融资项目上的账户归集带出 */
  fundUseId?: number;
  fundUse?: string;
  page: number;
  lineNo: number;
  /** 印刷顺序的排序键。手工补录的行落在相邻两笔之间时是小数 */
  sortKey: number;
  /** parsed=解析得到，manual=人工补录 */
  source: 'parsed' | 'manual';
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
  riskFlags: string[];
  confidence: number;
  /** 复核原因（低置信/日期/行号/余额断裂等，M3 修正队列展示） */
  reviewNote?: string;
  rawText?: string;
  status: TxStatus;
  /** 交易页打上的关注标记。关注页的处理不会改它 */
  watched?: boolean;
}

/** 关注页判定。没有记录时界面显示「待处理」 */
export const WATCH_VERDICTS = ['有问题', '无问题', '已处理'] as const;
export type WatchVerdict = (typeof WATCH_VERDICTS)[number];

export interface WatchLog {
  id: number;
  kind: 'mark' | 'unmark' | 'note' | 'verdict';
  body: string;
  createdAt: string;
}

export interface WatchItem {
  tx: TxRow;
  verdict?: WatchVerdict;
  /** 关注页上的交易情况备忘，一条可反复修改的文字 */
  memo: string;
  logs: WatchLog[];
}

export interface TxQuery {
  taskId?: number;
  fileId?: number;
  bank?: string;
  /** 开户主体，与列表展示的名称一致 */
  holder?: string;
  accountNo?: string;
  /** 募投项目。数字 id，'__none__' 表示未归集，'__transit__' / '__tempflow__' 是通用选项 */
  fundUse?: string;
  from?: string;
  to?: string;
  counterparty?: string;
  q?: string;
  status?: TxStatus;
  /** 分类过滤：'__none__' = 未分类 */
  category?: string;
  /** date_desc / date_asc / amount_desc；缺省 stmt = 流水印刷顺序 */
  sort?: 'stmt' | 'date_desc' | 'date_asc' | 'amount_desc';
  page?: number;
  pageSize?: number;
}

export interface TxPageResult {
  rows: TxRow[];
  total: number;
  inflow: number;
  outflow: number;
}

export interface TxOptions {
  tasks: { id: number; name: string; clientName: string; projectName: string; txCount: number }[];
  /** 当前其余条件下出现过的募投项目 */
  fundUses: { id: number; name: string }[];
  /** 有账号尚未归集到募投项目，且不是通用选项 */
  hasUnassignedFundUse: boolean;
  /** 当前条件下出现过的通用募投选项，如多项目中转、临时补流 */
  specialFundUses: { query: string; label: string }[];
  banks: string[];
  /** 当前任务里出现过的开户主体 */
  holders: string[];
  accounts: string[];
  categories: string[];
}

export type FundUseKind = '原始项目' | '新增项目';

export interface FundUse {
  id: number;
  projectId: number;
  name: string;
  kind?: FundUseKind;
  /** 项目性质为新增项目时的新增时间 */
  addedOn?: string;
  /** 调整后投资总额，元 */
  adjustedAmount?: number;
}

/** 账号比对键：去掉空白和横线，字母大写。手工清单和解析结果用同一把尺子。 */
export function normAccountNo(raw: string | null | undefined): string {
  return String(raw ?? '').replace(/[\s\u3000\-]/g, '').toUpperCase();
}

/** 现金管理：上期末仍在运作的本金，以及各次董事会审议的时间与额度。金额都是元。 */
export interface CashBoard {
  id: number;
  startDate: string;
  endDate: string;
  limitAmount: number;
  note: string;
}

export interface CashMandate {
  opening: number;
  /** 上期末余额的截止日。这一天之后的申购、赎回才增减余额 */
  openingAsOf: string;
  boards: CashBoard[];
}

/** 报表：当前任务里每个募集资金专户流水的最终余额 */
export interface DedicatedBalance {
  holder: string;
  bank: string;
  accountNo: string;
  /** 该专户流水中日期最晚、且印有余额的那一笔。没有流水则为空 */
  balance?: number;
}

/** 现金管理期末余额里，点开一行看到的流水 */
export interface CashLotLine {
  id: number;
  date?: string;
  direction: 'in' | 'out';
  amount: number;
  summary?: string;
  counterparty?: string;
  counterpartyAccount?: string;
  category?: string;
  /** 这一笔在该笔现金管理里扮演的角色 */
  role: 'purchase' | 'redemption' | 'interest';
}

/**
 * 一笔现金管理。购买和赎回按同一账户、金额和日期配对，不是银行存单号。
 * 购买不在本期时 purchaseMissing 为真。还没赎回时 open 为真。
 * 收益没单独入账、又减不出本金时 interestUnknown 为真。
 * 用户手填本金和利息后 manualSplit 为真，期末余额和利息合计按手填数计算。
 */
export interface CashLot {
  id: string;
  /** 账户主体，来自募资专户登记 */
  holder?: string;
  bank?: string;
  accountNo?: string;
  fundUse?: string;
  purchaseAmount?: number;
  purchaseDate?: string;
  purchaseMissing: boolean;
  redemptionAmount?: number;
  redemptionDate?: string;
  open: boolean;
  interest?: number;
  interestUnknown: boolean;
  /** 本息写在同一笔，用户已手填本金和利息 */
  manualSplit: boolean;
  /** 同一金额有多笔、购买日不同，按先买先赎配上的 */
  ambiguous: boolean;
  /** 只有收益、没有配上的本金 */
  interestOnly: boolean;
  lines: CashLotLine[];
}

export interface CashLotReport {
  rows: CashLot[];
  /** 期末未赎回：本期购买尚未赎回 + 上期购买尚未赎回 */
  ending: number;
  /** 已经能分开的利息，含上期购买、本期赎回且能拆开的收益 */
  interest: number;
  /** 上期末余额扣掉本期已赎回的上期本金。期末未赎回已含这笔合计 */
  priorOpen: number;
}

/**
 * 不挂具体募投项目、但有固定含义的专户选项。
 * 库里只存 role，界面和流水上显示 label。query 是交易筛选的取值。
 */
export const SPECIAL_FUND_USES = [
  { role: 'transit', label: '多项目中转', query: '__transit__' },
  { role: 'tempflow', label: '临时补流', query: '__tempflow__' },
] as const;

export type SpecialFundUseRole = (typeof SPECIAL_FUND_USES)[number]['role'];

export const TRANSIT_USE_ROLE: SpecialFundUseRole = 'transit';
export const TRANSIT_FUND_USE_LABEL = '多项目中转';

export function specialFundUseByRole(role: string | null | undefined) {
  return SPECIAL_FUND_USES.find((item) => item.role === role);
}

export function specialFundUseByQuery(query: string | null | undefined) {
  return SPECIAL_FUND_USES.find((item) => item.query === query);
}

/** 专户角色换成展示名，否则用募投项目名。 */
export function fundUseNameCaseSql(roleExpr = 'fua.use_role', nameExpr = 'fu.name'): string {
  const whens = SPECIAL_FUND_USES.map((item) => `WHEN ${roleExpr} = '${item.role}' THEN '${item.label}'`).join(' ');
  return `CASE ${whens} ELSE ${nameExpr} END`;
}

export function specialFundUseRoleInSql(roleExpr = 'fua.use_role'): string {
  return `${roleExpr} IN (${SPECIAL_FUND_USES.map((item) => `'${item.role}'`).join(', ')})`;
}

/** 融资项目上手工登记的募资专户。募投项目是挂上去的，不存在流水里。 */
export interface ProjectAccount {
  id: number;
  holder: string;
  bank: string;
  accountNo: string;
  fundUseId?: number;
  fundUse?: string;
  /** 通用选项。和「不挂」都没有 fundUseId。 */
  useRole?: SpecialFundUseRole;
  /** 开户日期 YYYY-MM-DD，未填为空 */
  openedOn?: string;
}

/** 顶栏「当前任务」上下文切换器（Avalon ChromeContextTab，M2 交付） */
export interface TaskBrief {
  id: number;
  name: string;
  clientName: string;
  projectName: string;
  fileCount: number;
  txCount: number;
  updatedAt: string;
}

export interface DashboardSummary {
  fileCount: number;
  txCount: number;
  inflow: number;
  outflow: number;
  openHits: number;
  byCategory: { category: string; count: number; amount: number }[];
}

/* ---------- 资金流向（分析页） ---------- */

export type FlowKind = 'dedicated' | 'own' | 'external' | 'treasury';

export interface FlowNode {
  id: string;
  role: 'dedicated' | 'own' | 'external' | 'bucket' | 'treasury';
  /** 圆内或标题：银行简称 / 对方简称 */
  title: string;
  /** 账号后四位 */
  tail?: string;
  /** 悬停或旁注 */
  sub?: string;
}

export interface FlowLine {
  id: number;
  date?: string;
  direction: 'in' | 'out';
  amount: number;
  summary?: string;
  counterparty?: string;
  counterpartyAccount?: string;
  balance?: number;
  /** 该笔交易的分类（M4） */
  category?: string;
}

/** 分类分布统计：category 为 null 表示未分类 */
export interface CategoryCount {
  category: string | null;
  count: number;
}

/** LLM 批量分类结果（M4） */
export interface ClassifyOutcome {
  /** 本次待分类的笔数 */
  total: number;
  classified: number;
  /** 低置信、进修正队列待人工确认 */
  lowConfidence: number;
  message?: string;
}

export interface FlowLink {
  id: string;
  from: string;
  to: string;
  kind: FlowKind;
  /** from → to，同一笔只计一次 */
  outAmount: number;
  outCount: number;
  /** 其中双方专户流水都能对上的金额 */
  outBoth: number;
  /** to → from */
  inAmount: number;
  inCount: number;
  inBoth: number;
  /** 组成这一行的流水，供复查 */
  lines?: FlowLine[];
  /** 组成这一行的交易 id（批量改判用，M4） */
  txIds?: number[];
  /** 这批交易的分类分布（null = 未分类），M4 */
  categories?: CategoryCount[];
}

export interface FlowMove {
  date: string;
  accountId: string;
  direction: 'in' | 'out';
  amount: number;
  count: number;
  kind: FlowKind;
  peer: string;
}

export interface FlowBalance {
  accountId: string;
  points: { date: string; balance: number }[];
}

export interface FlowPartyLine {
  name: string;
  accountNo?: string;
  /** 发生这笔的募资专户节点，对外汇总时可空 */
  accountTitle?: string;
  count: number;
  outAmount: number;
  inAmount: number;
  /** 频率低，画进「对外转出」 */
  grouped?: boolean;
  /** 这条线路下的交易 id（批量改判用，M4） */
  txIds?: number[];
  /** 这批交易的分类分布（null = 未分类），M4 */
  categories?: CategoryCount[];
}

export interface FlowResult {
  taskId: number;
  taskName: string;
  clientName: string;
  generatedAt: string;
  /** llm：模型参与了判断；rules：没有需要模型判断的组，或模型不可用 */
  source: 'llm' | 'rules';
  /** 问过模型但失败，退回账号和摘要规则 */
  fallback?: boolean;
  txCount: number;
  /** 不是募资专户的流水，没有画进去 */
  skipped: number;
  nodes: FlowNode[];
  links: FlowLink[];
  /** 按日、按专户的进出，含对手 */
  moves?: FlowMove[];
  /** 各专户日终余额 */
  balances?: FlowBalance[];
  externalLines: FlowPartyLine[];
  treasuryLines: FlowPartyLine[];
}

export interface FlowResponse {
  status: 'missing' | 'ready' | 'stale' | 'empty';
  message?: string;
  result?: FlowResult;
}

/** 分析页专题：按交易分类单独汇总，不参与资金流向重算 */
export interface CategoryFocusParty {
  name: string;
  accountNo?: string;
  outAmount: number;
  outCount: number;
  inAmount: number;
  inCount: number;
  firstDate?: string;
  lastDate?: string;
}

export interface CategoryFocusLine {
  id: number;
  date?: string;
  direction: 'in' | 'out';
  amount: number;
  summary?: string;
  counterparty?: string;
  counterpartyAccount?: string;
  bank?: string;
  accountNo?: string;
  /** 募资专户的账户主体 */
  holder?: string;
  fundUse?: string;
}

export interface CategoryFocus {
  category: '临时补流' | '现金管理' | '实施中置换';
  outAmount: number;
  outCount: number;
  inAmount: number;
  inCount: number;
  /** 转出减转入。临时补流是尚未归还，现金管理是仍在运作，实施中置换是已置换 */
  netOut: number;
  parties: CategoryFocusParty[];
  lines: CategoryFocusLine[];
  /** 现金管理页附带的投资收益，不冲减本金 */
  incomeAmount?: number;
  incomeCount?: number;
  incomeLines?: CategoryFocusLine[];
}

/* ---------- 默认配置 ---------- */

export const DEFAULT_SETTINGS: Settings = {
  llmBase: 'http://127.0.0.1:8005/v1',
  llmModel: '',
  llmExtraHeader: '',
  llmProfiles: [],
  defaultLlmId: '',
  ocrBase: 'http://127.0.0.1:8008',
  ocrExtraHeader: '',
  llmConcurrency: 2,
  autoCategorize: true,
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

/** 默认分类的定义（喂给 LLM 的分类说明，§5.4） */
export const CATEGORY_DEFS: Record<string, string> = {
  项目投入: '募集资金投向募投项目：工程款、设备/材料采购、土地出让金、项目相关大额对外付款',
  临时补流: '募集资金临时转出补充流动资金（通常约定期限内归还）',
  现金管理: '闲置资金存放与运作：活期/定期存单、结构性存款、理财产品申购赎回、大额存单',
  手续费: '银行手续费、汇款手续费、账户管理费',
  利息: '存款利息收入或贷款利息支出',
  现金管理投资收益: '理财/存单到期兑付的投资收益、大额存单利息收入',
  其他: '不属于以上类别的交易',
  '货款/服务': '经营性货款、服务费往来',
  关联方往来: '与已登记关联方/子公司的资金往来',
  税费: '税款缴纳与返还',
  '工资/社保': '工资、社保、公积金发放',
};
