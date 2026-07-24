// Shared model/effort vocabulary — one source of truth so every picker
// (Orchestrate dock, ticket sheet, ticket modal, settings) offers the same
// options in the same order. Previously each surface hand-rolled its own copy
// and drifted (ticket modal was missing xhigh/max).
export const MODELS = ["haiku", "sonnet", "opus", "fable"];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
