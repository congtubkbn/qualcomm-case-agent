# Per-field Detail Field Provenance, not a per-capture flag

An update run's --merge path must decide, per Detail-tab field, whether a fresh
value overwrites the cache or the cache wins. The first fix used one per-capture
flag (`detailExtracted`): "did the Detail tab load this run?" That let stale
Feed-tab noise (a wrong-DOM-region value) overwrite good cached fields on cases
where the Detail tab genuinely doesn't render a given field (e.g. no Severity
picklist). We replaced it with per-field provenance (`raw.detailFields`, see
Detail Field Provenance in CONTEXT.md): only a field the Detail tab actually
supplied *this run* is eligible to overwrite the cache; everything else falls
back to fill-blanks-only. Costs one extra list to carry through `mergeDetailFields`
and the finalizer's merge branch, but it's the only version that doesn't
regress silently on cases with sparse Detail-tab schemas.
