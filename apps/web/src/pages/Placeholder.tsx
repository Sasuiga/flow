export default function Placeholder({ name, note }: { name: string; note: string }) {
  return (
    <div style={{ padding: 60, textAlign: 'center', color: '#888' }}>
      <div style={{ fontSize: 22, fontWeight: 600, color: '#333', marginBottom: 12 }}>{name}</div>
      <div>{note}</div>
    </div>
  );
}
