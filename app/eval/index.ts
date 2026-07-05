// @app/eval - Eval_Harness and VerilogEval/RTLLM subset fixtures.
//
// Consumer layer: it may import any inner layer to drive the loop end to end, and
// nothing imports it. The ratcheting pass@k gate and subset runner are implemented
// in tasks 19-20.

import { API_LAYER } from '@app/api';

/** Layer identifier, proving the eval harness resolves the full inner chain. */
export const EVAL_LAYER = `${API_LAYER}:eval` as const;
