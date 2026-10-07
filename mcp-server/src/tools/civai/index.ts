/**
 * CivAI's MCP tools, kept in their own folder so the fork's changes to upstream files stay
 * a single registration line in ../index.ts.
 */

import createGetMapAreaTool from "./get-map-area.js";
import createGetResourceTool from "./get-resource.js";
import createGetImprovementTool from "./get-improvement.js";
import createGetPromotionTool from "./get-promotion.js";
import createGetConceptTool from "./get-concept.js";

/** Factories for CivAI's tools, merged into the server's tool factory map. */
export const civaiToolFactories = {
  getMapArea: createGetMapAreaTool,
  getResource: createGetResourceTool,
  getImprovement: createGetImprovementTool,
  getPromotion: createGetPromotionTool,
  getConcept: createGetConceptTool,
} as const;
