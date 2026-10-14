type PlaceholderProps = {
  name: string;
  note: string;
  milestone: string;
};

/** 未交付模块的占位页（Avalon 空态观感） */
export default function Placeholder({ name, note, milestone }: PlaceholderProps) {
  return (
    <div className="page">
      <div className="flow-placeholder">
        <h3>{name}</h3>
        <p>{note}</p>
        <div style={{ marginTop: 14 }}>
          <span className="chip chip-primary">{milestone}</span>
        </div>
      </div>
    </div>
  );
}
