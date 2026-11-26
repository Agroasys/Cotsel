'use strict';
const crypto = require('node:crypto');
const { canonicalJson } = require('./reconciliationEvidence');
const digest = (body) => crypto.createHash('sha256').update(canonicalJson(body)).digest('hex');
const bytes = (value) => Buffer.from(canonicalJson(value), 'utf8');
const schema = 'cotsel.reconciliation-action-response.v1';

/** Sign only a server-loaded snapshot, never caller-supplied evidence. */
async function attestActionEvidence(body, { challenge, resource, signer, now = Date.now() }) {
  if (!/^[a-f0-9]{64}$/.test(challenge)) throw new Error('Invalid evidence challenge');
  const latest = (body.proof?.recovery ?? body).latest?.seal?.manifest;
  if (!latest?.context) throw new Error('A signed snapshot is required');
  const payload = {
    schema,
    challenge,
    resource,
    context: latest.context,
    issuedAt: now,
    bodyDigest: digest(body),
    latestManifestDigest: digest(latest),
  };
  const signature = await signer.sign(bytes(payload));
  return {
    ...body,
    attestation: { payload, keyId: signer.keyId, signature: signature.toString('base64') },
  };
}

/** A fresh challenge proves this response was loaded after this lookup began. */
function verifyActionEvidence(
  response,
  { challenge, resource, context, publicKeys, now = Date.now() },
) {
  try {
    const { attestation, ...body } = response;
    const value = attestation.payload,
      key = publicKeys.get(attestation.keyId);
    const latest = (body.proof?.recovery ?? body).latest?.seal?.manifest;
    if (
      !key ||
      value.schema !== schema ||
      value.challenge !== challenge ||
      value.resource !== resource ||
      value.context?.chainId !== context.chainId ||
      value.context?.escrowAddress?.toLowerCase() !== context.escrowAddress.toLowerCase() ||
      !Number.isSafeInteger(value.issuedAt) ||
      value.issuedAt > now + 5000 ||
      now - value.issuedAt > 30000 ||
      value.bodyDigest !== digest(body) ||
      value.latestManifestDigest !== digest(latest) ||
      !crypto.verify('sha256', bytes(value), key, Buffer.from(attestation.signature, 'base64'))
    )
      return false;
    return true;
  } catch {
    return false;
  }
}
module.exports = { attestActionEvidence, verifyActionEvidence };
