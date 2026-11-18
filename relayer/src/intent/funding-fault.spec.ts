import { classifyFundingFault } from './funding-fault';

describe('classifyFundingFault', () => {
  it('classifies the live gas-selection failure as insufficient_gas', () => {
    const err = new Error(
      'Unable to perform gas selection due to insufficient SUI balance (in address balance ' +
        'or coins) for account 0xabc to satisfy required budget 4975277.',
    );
    expect(classifyFundingFault(err)).toBe('insufficient_gas');
  });

  it.each([
    'No valid gas coins found for the transaction.',
    'Transaction failed: InsufficientGas',
    'GasBalanceTooLow { gas_balance: 1, needed_gas_amount: 2 }',
    'Balance of gas object 0xdead is lower than the needed amount: 100',
    'Insufficient balance of 0x2::sui::SUI for owner 0xabc. Required: 10, Available: 1',
  ])('classifies %p as insufficient_gas', (msg) => {
    expect(classifyFundingFault(new Error(msg))).toBe('insufficient_gas');
  });

  it('classifies a WAL coinWithBalance shortfall as insufficient_wal', () => {
    const err = new Error(
      'Insufficient balance of 0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a' +
        '::wal::WAL for owner 0xabc. Required: 5000, Available: 12',
    );
    expect(classifyFundingFault(err)).toBe('insufficient_wal');
  });

  it('classifies a wrapped (stringified) error the same way', () => {
    expect(classifyFundingFault('StoreError: Unable to perform gas selection')).toBe(
      'insufficient_gas',
    );
  });

  it.each([
    new Error('walrus down'),
    new Error('blob id mismatch'),
    new Error('MoveAbort in execute_store, 2'),
    new Error('Store attempt exceeded 120000ms'),
    'fetch failed',
    undefined,
    null,
  ])('returns null for a non-funding error %p', (err) => {
    expect(classifyFundingFault(err)).toBeNull();
  });
});
