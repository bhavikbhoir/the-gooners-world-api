/**
 * Remotion Lambda render.
 *
 * The composition lives in the frontend repo and is deployed as a Remotion
 * "site" bundle to S3; a separate Remotion Lambda function renders it. Both are
 * provisioned outside this Serverless stack, so this module only needs their
 * names, passed in as environment variables.
 *
 * Uses @remotion/lambda-client, NOT @remotion/lambda. The full package depends
 * on @remotion/bundler, @remotion/cli and @remotion/renderer, which drag in
 * rspack, babel and esbuild — about 250MB. Serverless packages one zip shared
 * by every function, so that pushed unrelated functions past Lambda's 250MB
 * unzipped limit and broke the whole deploy. The client package has no
 * dependencies and only knows how to invoke a renderer someone else deployed.
 */

const { renderMediaOnLambda, getRenderProgress } = require('@remotion/lambda-client');

const REGION = process.env.AWS_REGION || 'us-east-1';
const FUNCTION_NAME = process.env.REMOTION_FUNCTION_NAME;
const SERVE_URL = process.env.REMOTION_SERVE_URL;
const COMPOSITION = 'MatchReview';

// A 25-35s vertical render finishes well inside this; the ceiling exists so a
// wedged render fails the orchestrator run instead of hanging it.
const POLL_MS = 3000;
const TIMEOUT_MS = 8 * 60 * 1000;

function assertConfigured() {
  if (!FUNCTION_NAME || !SERVE_URL) {
    throw new Error(
      'Remotion Lambda is not configured — set REMOTION_FUNCTION_NAME and REMOTION_SERVE_URL',
    );
  }
}

/** True when video rendering is available, so callers can degrade gracefully. */
function isRenderAvailable() {
  return Boolean(FUNCTION_NAME && SERVE_URL);
}

/**
 * Render one match review and wait for the finished file.
 *
 * Remotion writes the mp4 into its own output bucket rather than ours, so the
 * caller gets a URL and the S3 coordinates, not a buffer — a 2-3MB video does
 * not need to travel through this Lambda's memory.
 *
 * @returns {Promise<{url: string, bucketName: string, outKey: string, sizeBytes: number, renderId: string}>}
 */
async function renderMatchVideo(props) {
  assertConfigured();

  const { renderId, bucketName } = await renderMediaOnLambda({
    region: REGION,
    functionName: FUNCTION_NAME,
    serveUrl: SERVE_URL,
    composition: COMPOSITION,
    inputProps: props,
    codec: 'h264',
    imageFormat: 'jpeg',
    crf: 18,
    privacy: 'private',
    downloadBehavior: { type: 'play-in-browser' },
  });

  const startedAt = Date.now();
  for (;;) {
    const progress = await getRenderProgress({
      renderId, bucketName, functionName: FUNCTION_NAME, region: REGION,
    });

    if (progress.fatalErrorEncountered) {
      const first = progress.errors?.[0];
      throw new Error(`Remotion render failed: ${first?.message || 'unknown error'}`);
    }
    if (progress.done) {
      return {
        url: progress.outputFile,
        bucketName,
        outKey: progress.outKey,
        sizeBytes: progress.outputSizeInBytes,
        renderId,
      };
    }
    if (Date.now() - startedAt > TIMEOUT_MS) {
      throw new Error(`Remotion render timed out after ${TIMEOUT_MS / 1000}s (renderId ${renderId})`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

module.exports = { renderMatchVideo, isRenderAvailable };
