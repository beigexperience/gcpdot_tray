async function isScreenTurnedOff(): Promise<boolean> {

  if (Deno.build.os !== "windows") {
    console.warn("[os_integration_utils] isScreenTurnedOff is only implemented for Windows.");
    return false; // Only implemented for Windows
  }

  const command = new Deno.Command("powershell", {
    args: [
      "-Command",
      `
      $monitors = Get-WmiObject -Namespace root\\wmi -Class WmiMonitorBasicDisplayParams
      $powerStatus = Get-WmiObject -Namespace root\\wmi -Class WmiMonitorBrightnessMethods
      # This is a best-effort check; actual "off" state may not be detectable
      $isOff = $powerStatus | Where-Object { $_.WmiSetBrightness -eq 0 }
      if ($isOff) { Write-Output "OFF" } else { Write-Output "ON" }
      `
    ],
  });
  try {
    const { stdout } = await command.output();
    const result = new TextDecoder().decode(stdout).trim();
    return result === "OFF";
  } catch {
    return false;
  }
}

export { isScreenTurnedOff };