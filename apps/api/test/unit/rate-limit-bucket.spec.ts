import { rateLimitBucket } from '../../src/common/client-address';

// مفتاح حد المعدل: IPv6 على /64، وIPv4 والمعيَّن عليه كما هو (ملاحظة الأمن على #409)
describe('rateLimitBucket', () => {
  it('groups IPv6 by its /64 and keeps IPv4', () => {
    expect(rateLimitBucket('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(rateLimitBucket('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(rateLimitBucket('2001:0DB8:0001:0002::1')).toBe('2001:db8:1:2::/64');
    expect(rateLimitBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateLimitBucket('::1')).toBe('0:0:0:0::/64');
    expect(rateLimitBucket('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(rateLimitBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitBucket('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitBucket('unknown')).toBe('unknown');
  });
});
