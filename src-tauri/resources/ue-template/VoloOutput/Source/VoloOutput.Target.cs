using UnrealBuildTool;

public class VoloOutputTarget : TargetRules
{
	public VoloOutputTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.V7;
		IncludeOrderVersion = EngineIncludeOrderVersion.Unreal5_8;
		ExtraModuleNames.Add("VoloOutput");
	}
}
