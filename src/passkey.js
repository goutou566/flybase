import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const RP_NAME = 'flybase';
const RP_ID_HOST = 'pan.goutou.dpdns.org';
const ADMIN_USER = 'admin';
const CHALLENGE_TTL = 300;
const SESSION_TTL = 7 * 24 * 3600;

function rpID(env) {
  return env.PASSKEY_RP_ID || RP_ID_HOST;
}

function originFor(request, env) {
  if (env.PASSKEY_ORIGIN) {
    return env.PASSKEY_ORIGIN;
  }
  const url = new URL(request.url);
  return url.origin;
}

function b64urlEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getPasskey(env) {
  return env.PASSKEY_KV.get('passkey:admin', 'json');
}

export async function beginRegistration(request, env) {
  const existing = await getPasskey(env);
  if (existing && existing.registered) {
    return { error: 'Passkey already registered. Delete it first to re-register.', status: 409 };
  }

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpID(env),
    userName: ADMIN_USER,
    userDisplayName: 'flybase admin',
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'preferred',
    },
  });

  await env.PASSKEY_KV.put('challenge:reg', JSON.stringify(options), {
    expirationTtl: CHALLENGE_TTL,
  });
  return { options };
}

export async function finishRegistration(request, env) {
  const existing = await getPasskey(env);
  if (existing && existing.registered) {
    return { error: 'Passkey already registered.', status: 409 };
  }

  const optionsJSON = await env.PASSKEY_KV.get('challenge:reg', 'json');
  if (!optionsJSON) {
    return { error: 'No pending registration. Start again.', status: 400 };
  }

  const body = await request.json();
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge: optionsJSON.challenge,
      expectedOrigin: originFor(request, env),
      expectedRPID: rpID(env),
      requireUserVerification: false,
    });
  } catch (err) {
    return { error: `Registration verify failed: ${err.message}`, status: 400 };
  }

  if (!verification.verified || !verification.registrationInfo) {
    return { error: 'Registration not verified', status: 400 };
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const passkey = {
    registered: true,
    webAuthnUserID: optionsJSON.user.id,
    id: credential.id,
    publicKey: b64urlEncode(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports,
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    createdAt: new Date().toISOString(),
  };

  await env.PASSKEY_KV.put('passkey:admin', JSON.stringify(passkey));
  await env.PASSKEY_KV.delete('challenge:reg');
  return { ok: true };
}

export async function beginLogin(request, env) {
  const passkey = await getPasskey(env);
  if (!passkey || !passkey.registered) {
    return { error: 'No passkey registered yet.', status: 404 };
  }

  const options = await generateAuthenticationOptions({
    rpID: rpID(env),
    allowCredentials: [{ id: passkey.id, transports: passkey.transports }],
    userVerification: 'preferred',
  });

  await env.PASSKEY_KV.put('challenge:auth', JSON.stringify(options), {
    expirationTtl: CHALLENGE_TTL,
  });
  return { options };
}

export async function finishLogin(request, env) {
  const passkey = await getPasskey(env);
  if (!passkey || !passkey.registered) {
    return { error: 'No passkey registered yet.', status: 404 };
  }

  const optionsJSON = await env.PASSKEY_KV.get('challenge:auth', 'json');
  if (!optionsJSON) {
    return { error: 'No pending login. Start again.', status: 400 };
  }

  const body = await request.json();
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge: optionsJSON.challenge,
      expectedOrigin: originFor(request, env),
      expectedRPID: rpID(env),
      requireUserVerification: false,
      credential: {
        id: passkey.id,
        publicKey: b64urlDecode(passkey.publicKey),
        counter: passkey.counter,
        transports: passkey.transports,
      },
    });
  } catch (err) {
    return { error: `Login verify failed: ${err.message}`, status: 401 };
  }

  if (!verification.verified) {
    return { error: 'Login not verified', status: 401 };
  }

  passkey.counter = verification.authenticationInfo.newCounter;
  await env.PASSKEY_KV.put('passkey:admin', JSON.stringify(passkey));
  await env.PASSKEY_KV.delete('challenge:auth');

  const sessionToken = crypto.randomUUID() + crypto.randomUUID();
  const tokenHash = await sha256Hex(sessionToken);
  await env.PASSKEY_KV.put(`session:${tokenHash}`, ADMIN_USER, {
    expirationTtl: SESSION_TTL,
  });

  return { ok: true, sessionToken, expiresIn: SESSION_TTL };
}

export async function verifySession(request, env) {
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Bearer ')) {
    return false;
  }
  const tokenHash = await sha256Hex(header.slice(7).trim());
  const value = await env.PASSKEY_KV.get(`session:${tokenHash}`);
  return value === ADMIN_USER;
}

export async function logout(request, env) {
  const header = request.headers.get('authorization') || '';
  if (header.startsWith('Bearer ')) {
    const tokenHash = await sha256Hex(header.slice(7).trim());
    await env.PASSKEY_KV.delete(`session:${tokenHash}`);
  }
  return { ok: true };
}

export async function deletePasskey(request, env) {
  await env.PASSKEY_KV.delete('passkey:admin');
  await env.PASSKEY_KV.delete('challenge:reg');
  await env.PASSKEY_KV.delete('challenge:auth');
  return { ok: true };
}

export async function passkeyStatus(env) {
  const passkey = await getPasskey(env);
  if (!passkey || !passkey.registered) {
    return { registered: false };
  }
  return {
    registered: true,
    createdAt: passkey.createdAt,
    deviceType: passkey.deviceType,
    backedUp: passkey.backedUp,
    id: passkey.id.slice(0, 10) + '...',
  };
}
