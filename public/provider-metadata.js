let providers = [];

export function setProviderMetadata(values) {
  providers = Array.isArray(values) ? values : [];
}

export function providerMetadataFor(id) {
  const key = id ?? 'claude';
  return providers.find((p) => p.id === key) || { id: key, label: id == null ? 'Claude' : key, controls: {}, presentation: {} };
}

export function providerChoices() {
  return providers.map((p) => ({ value: p.id, label: p.label }));
}

export function canSwitchProviderModel(session) {
  return Boolean(session?.managed && session.status === 'idle' && providerMetadataFor(session.agent).controls?.switchModel);
}

export function needsYouTitle(session) {
  return `${providerMetadataFor(session.agent).label} needs you`;
}

export function billingProviderChoices() {
  const values = new Map(providers.flatMap((p) => (p.billingProviders || []).map((v) => [v.id, v])));
  return [{ v: '', label: 'All providers' }, ...[...values.values()].map((p) => ({ v: p.id, label: p.label }))];
}
