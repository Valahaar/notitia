import { makeSampler } from './sampler';

describe('makeSampler', () => {
    // pino-equivalent numeric levels
    const INFO = 30;
    const WARN = 40;
    const ERROR = 50;

    function simulate(sampler: ReturnType<typeof makeSampler>, args: unknown[], level: number) {
        let emitted = false;
        const method = function () { emitted = true; };
        sampler.call({}, args as any, method as any, level);
        return emitted;
    }

    it('passes warn unconditionally regardless of rate', () => {
        const sampler = makeSampler(0, () => 0.99);
        expect(simulate(sampler, [{ sampleable: true }, 'msg'], WARN)).toBe(true);
    });

    it('passes error unconditionally regardless of rate', () => {
        const sampler = makeSampler(0, () => 0.99);
        expect(simulate(sampler, [{ sampleable: true }, 'msg'], ERROR)).toBe(true);
    });

    it('passes audit: true at info even with rate=0', () => {
        const sampler = makeSampler(0, () => 0.99);
        expect(simulate(sampler, [{ audit: true }, 'msg'], INFO)).toBe(true);
    });

    it('passes info without sampleable flag regardless of rate', () => {
        const sampler = makeSampler(0, () => 0.99);
        expect(simulate(sampler, [{}, 'msg'], INFO)).toBe(true);
        expect(simulate(sampler, ['just a string'], INFO)).toBe(true);
    });

    it('drops sampleable info when random >= rate', () => {
        const sampler = makeSampler(0.1, () => 0.5); // 0.5 >= 0.1
        expect(simulate(sampler, [{ sampleable: true }, 'msg'], INFO)).toBe(false);
    });

    it('keeps sampleable info when random < rate', () => {
        const sampler = makeSampler(0.5, () => 0.1); // 0.1 < 0.5
        expect(simulate(sampler, [{ sampleable: true }, 'msg'], INFO)).toBe(true);
    });

    it('Monte Carlo: ~50% retention over many draws at rate 0.5', () => {
        let rngCount = 0;
        // deterministic sequence interleaving below/above 0.5
        const rng = () => ((rngCount++ % 10) * 0.1);
        const sampler = makeSampler(0.5, rng);
        let kept = 0;
        for (let i = 0; i < 10_000; i++) {
            if (simulate(sampler, [{ sampleable: true }, 'msg'], INFO)) kept++;
        }
        expect(kept).toBeGreaterThan(4_800);
        expect(kept).toBeLessThan(5_200);
    });
});
