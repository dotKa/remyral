import { describe, expect, it } from 'vitest';
import { amzDates, EMPTY_SHA256, presignUrl, signRequest, uriEncode } from '../../src/blobs/sigv4.js';

/**
 * p17-object-storage: the SigV4 signer against the worked examples of the Amazon S3 API reference ("Signature
 * Calculations for the Authorization Header: Transferring Payload in a Single Chunk" and "Authenticating Requests: Using
 * Query Parameters"). Credentials, bucket, dates and expected signatures are the documentation's.
 */
const creds = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};
const at = new Date('2013-05-24T00:00:00Z');

function signatureOf(authorization: string | undefined): string | undefined {
  return /Signature=([0-9a-f]{64})$/.exec(authorization ?? '')?.[1];
}

describe('SigV4 (AWS documentation examples)', () => {
  it('dates and RFC 3986 encoding', () => {
    expect(amzDates(at)).toEqual({ amzDate: '20130524T000000Z', date: '20130524' });
    expect(uriEncode('a b/c$d', true)).toBe('a%20b/c%24d');
    expect(uriEncode('a/b')).toBe('a%2Fb');
    expect(uriEncode("~-_.!*'()")).toBe('~-_.%21%2A%27%28%29');
  });

  it('GET object with a Range header', () => {
    const h = signRequest(
      {
        method: 'GET',
        url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
        headers: { range: 'bytes=0-9' },
        payloadHash: EMPTY_SHA256,
      },
      creds,
      'us-east-1',
      at,
    );
    expect(signatureOf(h.authorization)).toBe(
      'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(h.authorization).toContain(
      'Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date',
    );
  });

  it('PUT object (date + storage class headers, signed payload)', () => {
    const h = signRequest(
      {
        method: 'PUT',
        url: new URL('https://examplebucket.s3.amazonaws.com/test%24file.text'),
        headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
        payloadHash: '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
      },
      creds,
      'us-east-1',
      at,
    );
    expect(signatureOf(h.authorization)).toBe(
      '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    );
  });

  it('GET bucket lifecycle (empty query value)', () => {
    const h = signRequest(
      {
        method: 'GET',
        url: new URL('https://examplebucket.s3.amazonaws.com/?lifecycle'),
        payloadHash: EMPTY_SHA256,
      },
      creds,
      'us-east-1',
      at,
    );
    expect(signatureOf(h.authorization)).toBe(
      'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
    );
  });

  it('GET bucket list (sorted query)', () => {
    const h = signRequest(
      {
        method: 'GET',
        url: new URL('https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J'),
        payloadHash: EMPTY_SHA256,
      },
      creds,
      'us-east-1',
      at,
    );
    expect(signatureOf(h.authorization)).toBe(
      '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
    );
  });

  it('presigned GET (query-string authentication, 86400 s)', () => {
    const u = presignUrl(
      { method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt') },
      creds,
      'us-east-1',
      at,
      86_400,
    );
    expect(u.searchParams.get('X-Amz-Signature')).toBe(
      'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
    expect(u.searchParams.get('X-Amz-Credential')).toBe(
      'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request',
    );
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });

  it('presigning binds extra headers and refuses an out-of-range expiry', () => {
    const u = presignUrl(
      {
        method: 'PUT',
        url: new URL('http://127.0.0.1:9000/bucket/artifacts/x'),
        headers: { 'content-length': '5', 'content-type': 'application/zip' },
      },
      creds,
      'us-east-1',
      at,
      900,
    );
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(() =>
      presignUrl({ method: 'GET', url: new URL('https://x.example/k') }, creds, 'auto', at, 604_801),
    ).toThrow(RangeError);
  });
});
