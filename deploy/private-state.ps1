function Protect-PorosState([string]$Path) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $scope = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $security = Get-Acl -LiteralPath $Path
  $access = $security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
  if ($security.AreAccessRulesProtected -and $access.Count -eq 2 -and
    @($access | Where-Object { $_.IdentityReference -in $identity,$system -and $_.FileSystemRights -eq 'FullControl' -and $_.AccessControlType -eq 'Allow' }).Count -eq 2) { return }
  $security.SetAccessRuleProtection($true, $false)
  foreach ($rule in $security.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])) {
    $security.RemoveAccessRuleAll($rule)
  }
  foreach ($sid in @($identity, $system)) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $sid, 'FullControl', $scope, 'None', 'Allow'
    )
    $security.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $security
}
