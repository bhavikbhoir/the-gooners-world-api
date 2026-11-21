/**
 * S3 helpers for generated card images.
 * Images are stored privately; Instagram fetches via a short-lived presigned URL.
 */

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3 = new S3Client({ region: 'us-east-1' });
const BUCKET = process.env.S3_IMAGES_BUCKET;

async function putImage(key, buffer, contentType = 'image/jpeg') {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType }));
  return key;
}

/** Narration MP3s live in the same bucket; the renderer fetches via presigned URL. */
function putAudio(key, buffer) {
  return putImage(key, buffer, 'audio/mpeg');
}

async function getImage(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const c of res.Body) chunks.push(c);
  return Buffer.concat(chunks);
}

function presignGet(key, expiresIn = 300) {
  return presignFrom(BUCKET, key, expiresIn);
}

/**
 * Presign an object in any bucket we can read. Remotion Lambda writes rendered
 * videos into its own private bucket, so Instagram needs a signed URL pointing
 * there rather than at S3_IMAGES_BUCKET.
 */
function presignFrom(bucket, key, expiresIn = 300) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
}

module.exports = { putImage, putAudio, getImage, presignGet, presignFrom };
