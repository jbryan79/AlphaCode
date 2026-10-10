import type { VaultGraph as Graph } from '../shared/types';
export default function VaultGraph({ graph }: { graph: Graph | null; thinking: boolean; highlight: string[]; pulse: string }) {
  return <canvas className="vault-graph" aria-label="Vault graph" role="img" data-nodes={graph?.nodes.length ?? 0} />;
}
