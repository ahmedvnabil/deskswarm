/** Desktop control through the machine provider's native Cua Driver. */
import { providerFor } from "./providers";
import { driverCommand } from "./driver";
export interface ControlTarget {
  slug: string;
  provider?: string | null;
}
export class ControlError extends Error {}
export async function controlCommand(
  target: ControlTarget,
  command: string,
  params: Record<string, unknown> = {},
  timeoutMs = 30_000,
): Promise<any> {
  try {
    return await driverCommand(target, command, params, timeoutMs);
  } catch (err: any) {
    throw new ControlError(String(err?.message ?? err));
  }
}
export async function controlReady(target: ControlTarget): Promise<boolean> {
  try {
    const size = await providerFor(target).driverCall(
      target.slug,
      "get_screen_size",
      {},
      3000,
    );
    return Number(size?.width) > 0 && Number(size?.height) > 0;
  } catch {
    return false;
  }
}
