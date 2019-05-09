import { DeviceCheck } from "../DeviceCheck";
import { DeviceCheckResult } from "../DeviceCheckResult";

declare var device: any;
declare var document: any;

/**
 * Security check to detect if a device is running in an emulator.
 */
export class IsEmulatorCheck implements DeviceCheck {
  /**
   * Get the name of the check.
   */
  get name(): string {
    return "Emulator Check";
  }

  /**
   * Determine whether a device is being run in an emulator or not.
   * If the device is running in an emulator then the check will pass.
   *
   * @returns The result of the check.
   */
  public check(): Promise<DeviceCheckResult> {
    return new Promise((resolve, reject) => {
      if (!document) {
        reject(new Error("Cordova not fully loaded"));
      }

      document.addEventListener("deviceready", () => {
        if (!device) {
          reject(new Error("Could not find plugin device."));
          return;
        }
        const result: DeviceCheckResult = { name: this.name, passed: device.isVirtual };
        return resolve(result);
      }, false);
    });
  }
}
