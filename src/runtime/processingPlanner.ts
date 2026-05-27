import type {
  NormalizedAction,
  NormalizedCheck,
  NormalizedConfig,
  NormalizedRule,
} from '../config/legacyTypes';

export type PlannedCheckCostKind = 'local' | 'history' | 'external' | 'deferred';

export type PlannedCheck = {
  runIndex: number;
  runName: string;
  checkIndex: number;
  checkName: string;
  kind: NormalizedCheck['kind'];
  estimatedCost: number;
  costKinds: PlannedCheckCostKind[];
  reasons: string[];
};

export type ProcessingPlanChunk = {
  chunkIndex: number;
  estimatedCost: number;
  checks: PlannedCheck[];
  cursor: {
    runIndex: number;
    checkIndex: number;
  };
  nextCursor?: {
    runIndex: number;
    checkIndex: number;
  };
};

export type ProcessingPlan = {
  totalChecks: number;
  totalEstimatedCost: number;
  chunks: ProcessingPlanChunk[];
};

export type ProcessingPlanOptions = {
  maxChecksPerChunk?: number;
  maxCostPerChunk?: number;
};

const DEFAULT_MAX_CHECKS_PER_CHUNK = 25;
const DEFAULT_MAX_COST_PER_CHUNK = 25;

const expensiveRuleCosts: Record<string, { cost: number; reason: string }> = {
  attribution: {
    cost: 5,
    reason: 'attribution rule needs author history windows',
  },
  history: {
    cost: 7,
    reason: 'history rule needs historical activity fetches',
  },
  recentActivity: {
    cost: 6,
    reason: 'recentActivity rule needs recent activity fetches',
  },
  repeatActivity: {
    cost: 7,
    reason: 'repeatActivity rule needs history windows',
  },
  repost: {
    cost: 8,
    reason: 'repost rule needs duplicate/candidate lookups',
  },
};

const normalizePositiveInteger = (
  value: number | undefined,
  fallback: number,
  label: string
): number => {
  const normalized = Math.floor(value ?? fallback);
  if (!Number.isFinite(normalized) || normalized < 1) {
    throw new Error(`${label} must be a positive integer`);
  }

  return normalized;
};

const addCostKind = (
  values: Set<PlannedCheckCostKind>,
  kind: PlannedCheckCostKind
) => {
  values.add(kind);
};

const estimateRule = (
  rule: NormalizedRule,
  costKinds: Set<PlannedCheckCostKind>,
  reasons: string[]
): number => {
  if (rule.type === 'reference' || rule.type === 'include') {
    addCostKind(costKinds, 'deferred');
    reasons.push(`${rule.type} hydration is deferred`);
    return 2;
  }

  if (rule.type === 'ruleSet') {
    const childCost = rule.rules.reduce(
      (total, childRule) => total + estimateRule(childRule, costKinds, reasons),
      0
    );
    return Math.max(1, childCost);
  }

  const expensive = expensiveRuleCosts[rule.kind];
  if (expensive !== undefined) {
    addCostKind(costKinds, 'history');
    reasons.push(expensive.reason);
    return expensive.cost;
  }

  if (rule.kind === 'mhs' || rule.kind === 'sentiment') {
    addCostKind(costKinds, 'external');
    reasons.push(`${rule.kind} rule needs provider/runtime feasibility review`);
    return 8;
  }

  addCostKind(costKinds, 'local');
  return 1;
};

const estimateAction = (
  action: NormalizedAction,
  costKinds: Set<PlannedCheckCostKind>,
  reasons: string[]
): number => {
  if (action.type === 'reference' || action.type === 'include') {
    addCostKind(costKinds, 'deferred');
    reasons.push(`${action.type} action hydration is deferred`);
    return 2;
  }

  if (action.kind === 'dispatch' || action.kind === 'cancelDispatch') {
    addCostKind(costKinds, 'deferred');
    reasons.push(`${action.kind} action uses scheduler-backed dispatch`);
    return 2;
  }

  return 1;
};

const estimateCheck = (
  runIndex: number,
  runName: string,
  checkIndex: number,
  check: NormalizedCheck
): PlannedCheck => {
  const costKinds = new Set<PlannedCheckCostKind>();
  const reasons: string[] = [];
  const ruleCost = check.rules.reduce(
    (total, rule) => total + estimateRule(rule, costKinds, reasons),
    0
  );
  const actionCost = check.actions.reduce(
    (total, action) => total + estimateAction(action, costKinds, reasons),
    0
  );
  if (costKinds.size === 0) {
    addCostKind(costKinds, 'local');
  }

  return {
    runIndex,
    runName,
    checkIndex,
    checkName: check.name,
    kind: check.kind,
    estimatedCost: Math.max(1, 1 + ruleCost + actionCost),
    costKinds: [...costKinds],
    reasons,
  };
};

const flattenChecks = (config: NormalizedConfig): PlannedCheck[] =>
  config.runs.flatMap((run, runIndex) =>
    run.enabled
      ? run.checks
          .filter((check) => check.enabled)
          .map((check, checkIndex) =>
            estimateCheck(runIndex, run.name, checkIndex, check)
          )
      : []
  );

const makeChunk = (
  chunkIndex: number,
  checks: PlannedCheck[],
  nextCheck?: PlannedCheck
): ProcessingPlanChunk => {
  const first = checks[0];
  if (first === undefined) {
    throw new Error('processing plan chunk must contain at least one check');
  }

  return {
    chunkIndex,
    estimatedCost: checks.reduce((total, check) => total + check.estimatedCost, 0),
    checks,
    cursor: {
      runIndex: first.runIndex,
      checkIndex: first.checkIndex,
    },
    ...(nextCheck === undefined
      ? {}
      : {
          nextCursor: {
            runIndex: nextCheck.runIndex,
            checkIndex: nextCheck.checkIndex,
          },
        }),
  };
};

export const createProcessingPlan = (
  config: NormalizedConfig,
  options: ProcessingPlanOptions = {}
): ProcessingPlan => {
  const maxChecksPerChunk = normalizePositiveInteger(
    options.maxChecksPerChunk,
    DEFAULT_MAX_CHECKS_PER_CHUNK,
    'maxChecksPerChunk'
  );
  const maxCostPerChunk = normalizePositiveInteger(
    options.maxCostPerChunk,
    DEFAULT_MAX_COST_PER_CHUNK,
    'maxCostPerChunk'
  );
  const checks = flattenChecks(config);
  const chunks: ProcessingPlanChunk[] = [];
  let pending: PlannedCheck[] = [];
  let pendingCost = 0;

  for (const check of checks) {
    const wouldOverflow =
      pending.length > 0 &&
      (pending.length >= maxChecksPerChunk ||
        pendingCost + check.estimatedCost > maxCostPerChunk);

    if (wouldOverflow) {
      chunks.push(makeChunk(chunks.length, pending, check));
      pending = [];
      pendingCost = 0;
    }

    pending.push(check);
    pendingCost += check.estimatedCost;
  }

  if (pending.length > 0) {
    chunks.push(makeChunk(chunks.length, pending));
  }

  return {
    totalChecks: checks.length,
    totalEstimatedCost: checks.reduce(
      (total, check) => total + check.estimatedCost,
      0
    ),
    chunks,
  };
};

export const summarizeProcessingPlan = (plan: ProcessingPlan): string =>
  `Processing plan: ${plan.totalChecks} check(s), ${plan.chunks.length} chunk(s), estimated cost ${plan.totalEstimatedCost}.`;
