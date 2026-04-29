import { Injectable, UnauthorizedException } from '@nestjs/common';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

@Injectable()
export class AuthPasswordService {
  private readonly keyLength = 64;

  hashPassword(password: string): string {
    const normalized = this.normalizePassword(password);
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(normalized, salt, this.keyLength).toString('hex');
    return `scrypt$${salt}$${hash}`;
  }

  verifyPassword(password: string, encodedHash: string): boolean {
    const normalized = this.normalizePassword(password);
    const [algorithm, salt, hash] = encodedHash.split('$');
    if (algorithm !== 'scrypt' || !salt || !hash) {
      throw new UnauthorizedException('Stored password hash format is invalid.');
    }

    const expected = Buffer.from(hash, 'hex');
    const actual = scryptSync(normalized, salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private normalizePassword(password: string): string {
    return (password ?? '').normalize();
  }
}
