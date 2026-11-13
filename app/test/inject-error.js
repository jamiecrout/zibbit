/* loaded with node --require: throws from a timer and rejects a promise after the server is up, to see that it keeps serving */
setTimeout(() => { throw new Error('boom from https://secret.example/path?token=abc'); }, 1200);
setTimeout(() => { Promise.reject(new Error('rejected')); }, 1400);
