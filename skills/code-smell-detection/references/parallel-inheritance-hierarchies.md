# Parallel Inheritance Hierarchies

Category: Change Preventers

## Signals
- Adding one subtype forces matching subtype additions elsewhere.
- Related hierarchies must evolve in lockstep.
- Cross-hierarchy coupling increases maintenance cost.

## Common patterns to flag (anonymized)

Note: these snippets are examples. Real code often differs in syntax/structure; match on behavior and intent, not exact text.

### Mirrored subtype trees

```pseudo
class ReportPdf extends Report
class ReportCsv extends Report

class ReportPdfPresenter extends ReportPresenter
class ReportCsvPresenter extends ReportPresenter
```

Reviewer heuristic: when adding one subtype requires creating matching subtypes in another hierarchy, composition often fits better.

## Typical refactor directions
- Collapse or simplify related hierarchies.
- Replace Inheritance with Composition.
