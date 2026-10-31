# Registers (or refreshes) the AlanUpdateAllRunner task: every 5 minutes, runs the Update-all runner once
# (hidden). Safe when idle (exits quietly); a lock stops a second runner; logs rotate daily in
# %LOCALAPPDATA%\AlanUpdateAllRunner\logs.  Run:  powershell -ExecutionPolicy Bypass -File runner\install-scheduled-task.ps1
$ErrorActionPreference = "Stop"
$vbs = Join-Path $PSScriptRoot "run-hidden.vbs"
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 8) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "AlanUpdateAllRunner" -Action $action -Trigger $trigger -Settings $settings `
  -Description "Update all (BAU) runner: picks up runs requested from bau-workflow.html every 5 minutes" -Force | Out-Null
Get-ScheduledTask -TaskName "AlanUpdateAllRunner" | Select-Object TaskName, State
