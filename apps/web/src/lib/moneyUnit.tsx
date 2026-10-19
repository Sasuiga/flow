import { formatMoney } from './format';

export type MoneyUnit = 'yuan' | 'wan';

export function moneyUnitName(unit: MoneyUnit): string {
  return unit === 'yuan' ? '元' : '万元';
}

/** 输入框文字按当前单位换算成元。空、非数字、负数返回 null，0 合法。 */
export function parseMoneyInput(text: string, unit: MoneyUnit): number | null {
  const raw = text.replace(/,/g, '').trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  const yuan = unit === 'yuan' ? n : n * 10000;
  return Math.round(yuan * 100) / 100;
}

/** 元格式化成输入框文字，不带千分位。 */
export function formatMoneyInput(yuan: number, unit: MoneyUnit): string {
  const n = unit === 'yuan' ? yuan : yuan / 10000;
  const text = n.toFixed(unit === 'yuan' ? 2 : 6).replace(/\.?0+$/, '');
  return text === '' ? '0' : text;
}

/** 切换单位时改写输入框，背后的元金额不变。空着或暂时非法的文字原样留下。 */
export function rescaleMoneyInput(text: string, from: MoneyUnit, to: MoneyUnit): string {
  if (from === to) return text;
  const yuan = parseMoneyInput(text, from);
  if (yuan == null) return text;
  return formatMoneyInput(yuan, to);
}

/** 金额按元或万元展示。传入的 n 始终是元。 */
export function formatByUnit(n: number, unit: MoneyUnit): string {
  if (unit === 'yuan') return formatMoney(n);
  return (n / 10000).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function MoneyUnitSelect({ value, onChange }: { value: MoneyUnit; onChange: (unit: MoneyUnit) => void }) {
  return (
    <label className="report-unit">
      单位
      <select className="input" value={value} onChange={(e) => onChange(e.target.value as MoneyUnit)}>
        <option value="yuan">元</option>
        <option value="wan">万元</option>
      </select>
    </label>
  );
}
