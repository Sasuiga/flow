import { formatMoney } from './format';

export type MoneyUnit = 'yuan' | 'wan';

export function moneyUnitName(unit: MoneyUnit): string {
  return unit === 'yuan' ? '元' : '万元';
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
