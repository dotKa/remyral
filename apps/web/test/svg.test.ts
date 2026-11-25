import { describe, expect, it } from 'vitest';
import { groupSecret, safeOtpauthUri, svgToDataUri } from '../src/lib/svg';
import { QR_SVG } from './helpers';

describe('svgToDataUri', () => {
  it('base64-encodes an SVG document for use in <img src>', () => {
    const uri = svgToDataUri(QR_SVG);
    expect(uri).toMatch(/^data:image\/svg\+xml;base64,/);
    const decoded = atob(uri?.split(',')[1] ?? '');
    expect(decoded).toBe(QR_SVG);
  });

  it('rejects anything that is not an SVG document', () => {
    expect(svgToDataUri('<script>alert(1)</script>')).toBeNull();
    expect(svgToDataUri('<svgx></svgx>')).toBeNull();
    expect(svgToDataUri('')).toBeNull();
  });
});

describe('safeOtpauthUri', () => {
  it('only allows otpauth://totp links', () => {
    const uri = 'otpauth://totp/Remyral:alex?secret=ABC&issuer=Remyral&algorithm=SHA1';
    expect(safeOtpauthUri(uri)).toBe(uri);
    expect(safeOtpauthUri('javascript:alert(1)')).toBeNull();
    expect(safeOtpauthUri('otpauth://hotp/x')).toBeNull();
    expect(safeOtpauthUri('otpauth://totp/x" onclick="y')).toBeNull();
  });
});

describe('groupSecret', () => {
  it('groups in fours', () => {
    expect(groupSecret('ABCDEFGHIJ')).toBe('ABCD EFGH IJ');
  });
});
