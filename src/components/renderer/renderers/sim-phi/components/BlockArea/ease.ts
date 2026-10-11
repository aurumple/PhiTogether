/**
 * 官方 blockArea 缓动语义（Phigros 4.0 噪域事件的 easeType 0..14）。
 *
 * 语义与 RPE 谱面事件缓动不同源（RPE 只用到其中一小部分，见 ../utils/tween.ts），
 * 这里按官方枚举单独实现：1..12 为 In/Out/InOut 的 n 次幂（n = (type-1)/3 商 + 2），
 * 13 = 恒 0（HoldStart），14 = 恒 1（JumpToEnd），0 与越界一律线性。
 * InOut 分支的倍率是 2^(n-1)（u=0.5 处衔接两段，n=2 时中点恰为 0.5）。
 * 每次求值 O(1)，直接算幂而不是存表，对每帧上万次事件插值更省。
 */
export function blockEase(type: number, x: number): number {
    const u = x < 0 ? 0 : x > 1 ? 1 : x;
    if (type === 13) return 0;
    if (type === 14) return 1;
    if (type <= 0 || type > 14) return u;
    const power = (((type - 1) / 3) | 0) + 2;
    switch ((type - 1) % 3) {
        case 0: // In
            return u ** power;
        case 1: // Out
            return 1 - (1 - u) ** power;
        default: {
            // InOut：官方 GetEase 乘 2^(n-1)
            if (u < 0.5) return (1 << (power - 1)) * u ** power;
            return 1 - (2 - 2 * u) ** power / 2;
        }
    }
}
