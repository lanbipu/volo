#pragma once

#include "CoreMinimal.h"
#include "DisplayClusterRootActor.h"
#include "Cluster/DisplayClusterClusterEvent.h"
#include "Cluster/IDisplayClusterClusterManager.h"
#include "VoloOutputRoot.generated.h"

UENUM()
enum class EVoloSeqState : uint8
{
	Idle = 0,
	Preloading,
	Ready,
	Playing,
};

/**
 * nDisplay root actor that polls volo_output manifest (v1/v2) and drives
 * viewport texture replacement for show/clear/sequence modes.
 *
 * Sequence path: preload frames → cluster ready/start barrier → tick by sync time.
 */
UCLASS()
class AVoloOutputRoot : public ADisplayClusterRootActor
{
	GENERATED_BODY()

public:
	AVoloOutputRoot(const FObjectInitializer& ObjectInitializer);

	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;
	virtual void Tick(float DeltaSeconds) override;

protected:
	UPROPERTY(EditAnywhere, Category = "VoloOutput")
	FString ManifestPath = TEXT("C:\\ProgramData\\UECM\\ndisplay-output\\session\\manifest.json");

	UPROPERTY(EditAnywhere, Category = "VoloOutput")
	float PollInterval = 0.5f;

	UPROPERTY(Transient)
	TObjectPtr<UTexture2D> ActiveTexture;

	UPROPERTY(Transient)
	TArray<TObjectPtr<UTexture2D>> Frames;

	UPROPERTY(Transient)
	int64 LastRevision = -1;

	UPROPERTY(Transient)
	int64 SeqRevision = -1;

	UPROPERTY(Transient)
	float SeqFps = 2.0f;

	UPROPERTY(Transient)
	double SeqT0 = 0.0;

	UPROPERTY(Transient)
	EVoloSeqState SeqState = EVoloSeqState::Idle;

	UPROPERTY(Transient)
	TSet<FString> ReadySet;

	UPROPERTY(Transient)
	int32 SeqCropX = 0;

	UPROPERTY(Transient)
	int32 SeqCropY = 0;

	UPROPERTY(Transient)
	int32 SeqCropW = 0;

	UPROPERTY(Transient)
	int32 SeqCropH = 0;

	UPROPERTY(Transient)
	FString SequenceDir;

	UPROPERTY(Transient)
	int32 FrameCount = 0;

	UPROPERTY(Transient)
	int32 PreloadIndex = 0;

	UPROPERTY(Transient)
	int32 CurrentPlayIndex = -1;

	FTimerHandle PollTimerHandle;
	FOnClusterEventJsonListener ClusterEventListener;
	bool bClusterListenerBound = false;
	double PreloadStartedAt = 0.0;

	void PollManifest();
	void HandleClusterEvent(const FDisplayClusterClusterEventJson& Event);

	bool LoadManifestJson(TSharedPtr<FJsonObject>& OutObject) const;
	bool ApplyShowTexture(UTexture2D* Texture, int32 CropX, int32 CropY, int32 CropW, int32 CropH);
	bool ClearViewportReplace();
	UDisplayClusterConfigurationViewport* FindLocalViewport() const;
	FString GetLocalNodeId() const;
	FString GetPrimaryNodeId() const;
	TArray<FString> GetClusterNodeIds() const;
	bool IsPrimaryNode() const;

	UTexture2D* ImportFrameTexture(const FString& Filename);
	void ConfigureImportedTexture(UTexture2D* Texture) const;
	void BeginSequencePreload(int64 Revision, const FString& Dir, int32 Count, float Fps,
		int32 CropX, int32 CropY, int32 CropW, int32 CropH);
	void TickPreload();
	void EmitReady(int64 Revision);
	void EmitStart(int64 Revision);
	bool TryEmitStartIfReady(int64 Revision);
	void BeginPlaying(int64 Revision);
	void TickPlaying();
	void ResetSequence(int64 Revision, const TCHAR* Reason);
	void LogVolo(const FString& Message) const;
};
