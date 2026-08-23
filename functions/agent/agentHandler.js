/**
 * Bedrock Agent Core — Action Group Handler
 *
 * Invoked by the Bedrock Agent (Claude Sonnet) when it selects a tool.
 * Each action returns structured raw data — Sonnet synthesises the final response.
 *
 * The tool implementations live in ./arsenalTools.js (the shared tool layer,
 * also consumed by the MCP server). This file is only the Bedrock Agent Core
 * protocol wrapper: it maps the incoming apiPath to a tool and formats the
 * messageVersion 1.0 response.
 */

const { TOOLS_BY_NAME } = require('./arsenalTools');

// ── Lambda handler (Bedrock Agent Core format) ─────────────────────
exports.handler = async (event) => {
  const actionGroup = event.actionGroup;
  const apiPath = event.apiPath;
  const httpMethod = event.httpMethod;
  const params = {};

  if (event.parameters) {
    event.parameters.forEach((p) => { params[p.name] = p.value; });
  }
  if (event.requestBody?.content?.['application/json']?.properties) {
    event.requestBody.content['application/json'].properties.forEach((p) => {
      params[p.name] = p.value;
    });
  }

  const actionName = apiPath.replace(/^\//, '');
  console.log(`Agent tool call: ${actionName}`, JSON.stringify(params));
  const tool = TOOLS_BY_NAME[actionName];

  if (!tool) {
    return {
      messageVersion: '1.0',
      response: {
        actionGroup, apiPath, httpMethod,
        httpStatusCode: 400,
        responseBody: { 'application/json': { body: JSON.stringify({ error: `Unknown action: ${apiPath}` }) } },
      },
    };
  }

  try {
    const result = await tool.handler(params);
    return {
      messageVersion: '1.0',
      response: {
        actionGroup, apiPath, httpMethod,
        httpStatusCode: 200,
        responseBody: { 'application/json': { body: JSON.stringify(result) } },
      },
    };
  } catch (err) {
    console.error(`Action ${actionName} error:`, err);
    return {
      messageVersion: '1.0',
      response: {
        actionGroup, apiPath, httpMethod,
        httpStatusCode: 500,
        responseBody: { 'application/json': { body: JSON.stringify({ error: err.message }) } },
      },
    };
  }
};
