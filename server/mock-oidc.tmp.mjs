import { OAuth2Server } from 'oauth2-mock-server';
const s = new OAuth2Server();
await s.issuer.keys.generate('RS256');
s.service.on('beforeTokenSigning', (t) => Object.assign(t.payload, { sub: 'ethan', email: 'admin@example.com', email_verified: true }));
await s.start(4400, 'localhost');
console.log('mock up');
