#include "VoloOutputRoot.h"

#include "Cluster/IDisplayClusterClusterManager.h"
#include "DisplayClusterConfigurationTypes.h"
#include "DisplayClusterConfigurationTypes_Viewport.h"
#include "Engine/Texture2D.h"
#include "IDisplayCluster.h"
#include "ImageUtils.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "TimerManager.h"

namespace
{
	constexpr const TCHAR* EventReady = TEXT("volo.sl.ready");
	constexpr const TCHAR* EventStart = TEXT("volo.sl.start");
	constexpr const TCHAR* EventCategory = TEXT("volo");
}

AVoloOutputRoot::AVoloOutputRoot(const FObjectInitializer& ObjectInitializer)
	: Super(ObjectInitializer)
{
	PrimaryActorTick.bCanEverTick = true;
	PrimaryActorTick.bStartWithTickEnabled = true;
	// VoloScreen remains on BP_VoloOutput (DisplayClusterBlueprint SCS).
}

void AVoloOutputRoot::BeginPlay()
{
	Super::BeginPlay();

	if (IDisplayCluster::IsAvailable())
	{
		if (IDisplayClusterClusterManager* ClusterMgr = IDisplayCluster::Get().GetClusterMgr())
		{
			ClusterEventListener = FOnClusterEventJsonListener::CreateUObject(
				this, &AVoloOutputRoot::HandleClusterEvent);
			ClusterMgr->AddClusterEventJsonListener(ClusterEventListener);
			bClusterListenerBound = true;
		}
	}

	GetWorldTimerManager().SetTimer(
		PollTimerHandle,
		FTimerDelegate::CreateUObject(this, &AVoloOutputRoot::PollManifest),
		PollInterval,
		true);

	LogVolo(TEXT("BeginPlay poll armed"));
}

void AVoloOutputRoot::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
	GetWorldTimerManager().ClearTimer(PollTimerHandle);

	if (bClusterListenerBound && IDisplayCluster::IsAvailable())
	{
		if (IDisplayClusterClusterManager* ClusterMgr = IDisplayCluster::Get().GetClusterMgr())
		{
			ClusterMgr->RemoveClusterEventJsonListener(ClusterEventListener);
		}
		bClusterListenerBound = false;
	}

	Super::EndPlay(EndPlayReason);
}

void AVoloOutputRoot::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);

	if (SeqState == EVoloSeqState::Preloading)
	{
		TickPreload();
	}
	else if (SeqState == EVoloSeqState::Playing)
	{
		TickPlaying();
	}
}

void AVoloOutputRoot::LogVolo(const FString& Message) const
{
	UE_LOG(LogTemp, Log, TEXT("VoloOutput: %s"), *Message);
}

FString AVoloOutputRoot::GetLocalNodeId() const
{
	if (IDisplayCluster::IsAvailable())
	{
		if (const IDisplayClusterClusterManager* ClusterMgr = IDisplayCluster::Get().GetClusterMgr())
		{
			return ClusterMgr->GetNodeId();
		}
	}
	return FString();
}

FString AVoloOutputRoot::GetPrimaryNodeId() const
{
	if (const UDisplayClusterConfigurationData* Config = GetConfigData())
	{
		if (Config->Cluster)
		{
			return Config->Cluster->PrimaryNode.Id;
		}
	}
	return FString();
}

TArray<FString> AVoloOutputRoot::GetClusterNodeIds() const
{
	TArray<FString> Ids;
	if (const UDisplayClusterConfigurationData* Config = GetConfigData())
	{
		if (Config->Cluster)
		{
			Config->Cluster->GetNodeIds(Ids);
		}
	}
	return Ids;
}

bool AVoloOutputRoot::IsPrimaryNode() const
{
	if (IDisplayCluster::IsAvailable())
	{
		if (const IDisplayClusterClusterManager* ClusterMgr = IDisplayCluster::Get().GetClusterMgr())
		{
			return ClusterMgr->IsPrimary();
		}
	}
	const FString Local = GetLocalNodeId();
	const FString Primary = GetPrimaryNodeId();
	return !Local.IsEmpty() && Local == Primary;
}

UDisplayClusterConfigurationViewport* AVoloOutputRoot::FindLocalViewport() const
{
	const UDisplayClusterConfigurationData* Config = GetConfigData();
	if (!Config || !Config->Cluster)
	{
		return nullptr;
	}

	const FString NodeId = GetLocalNodeId();
	const TObjectPtr<UDisplayClusterConfigurationClusterNode>* NodePtr = Config->Cluster->Nodes.Find(NodeId);
	if (!NodePtr || !NodePtr->Get())
	{
		LogVolo(FString::Printf(TEXT("node config missing: %s"), *NodeId));
		return nullptr;
	}

	UDisplayClusterConfigurationClusterNode* Node = NodePtr->Get();
	TArray<TObjectPtr<UDisplayClusterConfigurationViewport>> Values;
	Node->Viewports.GenerateValueArray(Values);
	if (Values.Num() != 1 || !Values[0])
	{
		LogVolo(FString::Printf(TEXT("expected 1 viewport, got %d"), Values.Num()));
		return nullptr;
	}
	return Values[0].Get();
}

void AVoloOutputRoot::ConfigureImportedTexture(UTexture2D* Texture) const
{
	if (!Texture)
	{
		return;
	}
	Texture->SRGB = true;
	Texture->MipGenSettings = TMGS_NoMipmaps;
	Texture->Filter = TF_Nearest;
	Texture->NeverStream = true;
	Texture->UpdateResource();
}

UTexture2D* AVoloOutputRoot::ImportFrameTexture(const FString& Filename)
{
	UTexture2D* Texture = FImageUtils::ImportFileAsTexture2D(Filename);
	ConfigureImportedTexture(Texture);
	return Texture;
}

bool AVoloOutputRoot::ApplyShowTexture(UTexture2D* Texture, int32 CropX, int32 CropY, int32 CropW, int32 CropH)
{
	if (!Texture)
	{
		return false;
	}

	UDisplayClusterConfigurationViewport* Viewport = FindLocalViewport();
	if (!Viewport)
	{
		return false;
	}

	ActiveTexture = Texture;

	FDisplayClusterConfigurationViewport_RenderSettings Settings = Viewport->RenderSettings;
	Settings.Replace.bAllowReplace = true;
	Settings.Replace.SourceTexture = Texture;
	Settings.Replace.bShouldUseTextureRegion = true;
	Settings.Replace.TextureRegion.Origin.X = CropX;
	Settings.Replace.TextureRegion.Origin.Y = CropY;
	Settings.Replace.TextureRegion.Size.W = CropW;
	Settings.Replace.TextureRegion.Size.H = CropH;
	Viewport->RenderSettings = Settings;

	return SetReplaceTextureFlagForAllViewports(true);
}

bool AVoloOutputRoot::ClearViewportReplace()
{
	UDisplayClusterConfigurationViewport* Viewport = FindLocalViewport();
	if (Viewport)
	{
		FDisplayClusterConfigurationViewport_RenderSettings Settings = Viewport->RenderSettings;
		Settings.Replace.bAllowReplace = false;
		Settings.Replace.SourceTexture = nullptr;
		Settings.Replace.bShouldUseTextureRegion = false;
		Viewport->RenderSettings = Settings;
	}
	ActiveTexture = nullptr;
	return SetReplaceTextureFlagForAllViewports(false);
}

bool AVoloOutputRoot::LoadManifestJson(TSharedPtr<FJsonObject>& OutObject) const
{
	FString Text;
	if (!FFileHelper::LoadFileToString(Text, *ManifestPath))
	{
		return false;
	}

	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
	TSharedPtr<FJsonObject> Parsed;
	if (!FJsonSerializer::Deserialize(Reader, Parsed) || !Parsed.IsValid())
	{
		return false;
	}
	OutObject = Parsed;
	return true;
}

void AVoloOutputRoot::PollManifest()
{
	TSharedPtr<FJsonObject> Json;
	if (!LoadManifestJson(Json))
	{
		return;
	}

	int64 Revision = 0;
	if (!Json->TryGetNumberField(TEXT("revision"), Revision))
	{
		return;
	}
	if (Revision <= LastRevision)
	{
		return;
	}

	FString Mode;
	Json->TryGetStringField(TEXT("mode"), Mode);

	if (Mode.Equals(TEXT("clear"), ESearchCase::IgnoreCase))
	{
		if (SeqState != EVoloSeqState::Idle)
		{
			ResetSequence(SeqRevision >= 0 ? SeqRevision : Revision, TEXT("abort"));
		}
		if (ClearViewportReplace())
		{
			LastRevision = Revision;
			LogVolo(FString::Printf(TEXT("applied clear rev=%lld"), Revision));
		}
		return;
	}

	auto ReadCrop = [&](int32& X, int32& Y, int32& W, int32& H)
	{
		double DX = 0, DY = 0, DW = 0, DH = 0;
		Json->TryGetNumberField(TEXT("crop_x"), DX);
		Json->TryGetNumberField(TEXT("crop_y"), DY);
		Json->TryGetNumberField(TEXT("crop_w"), DW);
		Json->TryGetNumberField(TEXT("crop_h"), DH);
		X = static_cast<int32>(DX);
		Y = static_cast<int32>(DY);
		W = static_cast<int32>(DW);
		H = static_cast<int32>(DH);
	};

	if (Mode.Equals(TEXT("sequence"), ESearchCase::IgnoreCase))
	{
		FString Dir;
		double Fps = 2.0;
		double Count = 0;
		Json->TryGetStringField(TEXT("sequence_dir"), Dir);
		Json->TryGetNumberField(TEXT("fps"), Fps);
		Json->TryGetNumberField(TEXT("frame_count"), Count);
		int32 CropX = 0, CropY = 0, CropW = 0, CropH = 0;
		ReadCrop(CropX, CropY, CropW, CropH);

		if (Dir.IsEmpty() || Count <= 0)
		{
			LogVolo(FString::Printf(TEXT("sequence manifest invalid rev=%lld"), Revision));
			return;
		}

		// Gate revision only after accepting the sequence job.
		LastRevision = Revision;
		BeginSequencePreload(Revision, Dir, static_cast<int32>(Count), static_cast<float>(Fps),
			CropX, CropY, CropW, CropH);
		return;
	}

	// show (v1/v2): image_path or texture_path
	FString ImagePath;
	if (!Json->TryGetStringField(TEXT("texture_path"), ImagePath))
	{
		Json->TryGetStringField(TEXT("image_path"), ImagePath);
	}
	if (ImagePath.IsEmpty())
	{
		return;
	}

	int32 CropX = 0, CropY = 0, CropW = 0, CropH = 0;
	ReadCrop(CropX, CropY, CropW, CropH);

	UTexture2D* Texture = ImportFrameTexture(ImagePath);
	if (!Texture)
	{
		LogVolo(FString::Printf(TEXT("import failed: %s"), *ImagePath));
		return;
	}

	if (ApplyShowTexture(Texture, CropX, CropY, CropW, CropH))
	{
		LastRevision = Revision;
		LogVolo(FString::Printf(TEXT("applied revision=%lld"), Revision));
		// Keep VOLO_OUTPUT line for legacy log greps from P0.
		UE_LOG(LogTemp, Log, TEXT("VOLO_OUTPUT applied revision=%lld"), Revision);
	}
}

void AVoloOutputRoot::BeginSequencePreload(int64 Revision, const FString& Dir, int32 Count, float Fps,
	int32 CropX, int32 CropY, int32 CropW, int32 CropH)
{
	if (SeqState != EVoloSeqState::Idle)
	{
		ResetSequence(SeqRevision, TEXT("abort"));
	}

	ClearViewportReplace();
	Frames.Reset();
	ReadySet.Reset();
	SeqRevision = Revision;
	SequenceDir = Dir;
	FrameCount = Count;
	SeqFps = Fps > KINDA_SMALL_NUMBER ? Fps : 2.0f;
	SeqCropX = CropX;
	SeqCropY = CropY;
	SeqCropW = CropW;
	SeqCropH = CropH;
	PreloadIndex = 0;
	CurrentPlayIndex = -1;
	SeqState = EVoloSeqState::Preloading;
	PreloadStartedAt = FPlatformTime::Seconds();
	LogVolo(FString::Printf(TEXT("sequence preload begin rev=%lld frames=%d fps=%.3f"), Revision, Count, SeqFps));
}

void AVoloOutputRoot::TickPreload()
{
	// Import 1–2 frames per tick to keep hitching bounded.
	const int32 Budget = 2;
	for (int32 i = 0; i < Budget && PreloadIndex < FrameCount; ++i)
	{
		const FString Filename = FPaths::Combine(SequenceDir, FString::Printf(TEXT("frame_%04d.png"), PreloadIndex));
		UTexture2D* Texture = ImportFrameTexture(Filename);
		if (!Texture)
		{
			LogVolo(FString::Printf(TEXT("sequence preload failed frame=%d path=%s"), PreloadIndex, *Filename));
			SeqState = EVoloSeqState::Idle;
			return;
		}
		Frames.Add(Texture);
		++PreloadIndex;
	}

	if (PreloadIndex >= FrameCount)
	{
		const double Elapsed = FPlatformTime::Seconds() - PreloadStartedAt;
		LogVolo(FString::Printf(TEXT("sequence preload done rev=%lld seconds=%.3f"), SeqRevision, Elapsed));
		SeqState = EVoloSeqState::Ready;
		EmitReady(SeqRevision);
	}
}

void AVoloOutputRoot::EmitReady(int64 Revision)
{
	const FString NodeId = GetLocalNodeId();
	LogVolo(FString::Printf(TEXT("sequence ready rev=%lld node=%s"), Revision, *NodeId));

	if (!IDisplayCluster::IsAvailable())
	{
		// Degenerate non-cluster editor preview: start immediately.
		BeginPlaying(Revision);
		return;
	}

	IDisplayClusterClusterManager* ClusterMgr = IDisplayCluster::Get().GetClusterMgr();
	if (!ClusterMgr)
	{
		BeginPlaying(Revision);
		return;
	}

	FDisplayClusterClusterEventJson Event;
	Event.Name = EventReady;
	Event.Type = EventReady;
	Event.Category = EventCategory;
	Event.bShouldDiscardOnRepeat = false;
	Event.Parameters.Add(TEXT("node_id"), NodeId);
	Event.Parameters.Add(TEXT("revision"), FString::Printf(TEXT("%lld"), Revision));
	ClusterMgr->EmitClusterEventJson(Event, false);

	// Primary also records its own ready (event echo path varies by topology).
	if (IsPrimaryNode())
	{
		ReadySet.Add(NodeId);
		TryEmitStartIfReady(Revision);
	}
}

void AVoloOutputRoot::EmitStart(int64 Revision)
{
	if (SeqState == EVoloSeqState::Playing)
	{
		return;
	}
	if (!IDisplayCluster::IsAvailable())
	{
		BeginPlaying(Revision);
		return;
	}
	IDisplayClusterClusterManager* ClusterMgr = IDisplayCluster::Get().GetClusterMgr();
	if (!ClusterMgr)
	{
		BeginPlaying(Revision);
		return;
	}

	FDisplayClusterClusterEventJson Event;
	Event.Name = EventStart;
	Event.Type = EventStart;
	Event.Category = EventCategory;
	Event.bShouldDiscardOnRepeat = true;
	Event.Parameters.Add(TEXT("revision"), FString::Printf(TEXT("%lld"), Revision));
	ClusterMgr->EmitClusterEventJson(Event, false);
	LogVolo(FString::Printf(TEXT("sequence emit start rev=%lld"), Revision));
}

void AVoloOutputRoot::HandleClusterEvent(const FDisplayClusterClusterEventJson& Event)
{
	if (Event.Name == EventReady || Event.Type == EventReady)
	{
		if (!IsPrimaryNode())
		{
			return;
		}
		const FString* NodeId = Event.Parameters.Find(TEXT("node_id"));
		const FString* RevStr = Event.Parameters.Find(TEXT("revision"));
		if (!NodeId || !RevStr)
		{
			return;
		}
		const int64 Revision = FCString::Atoi64(**RevStr);
		if (Revision != SeqRevision)
		{
			return;
		}
		ReadySet.Add(*NodeId);
		if (SeqState == EVoloSeqState::Ready)
		{
			TryEmitStartIfReady(Revision);
		}
		return;
	}

	if (Event.Name == EventStart || Event.Type == EventStart)
	{
		const FString* RevStr = Event.Parameters.Find(TEXT("revision"));
		if (!RevStr)
		{
			return;
		}
		const int64 Revision = FCString::Atoi64(**RevStr);
		if (Revision != SeqRevision)
		{
			return;
		}
		BeginPlaying(Revision);
	}
}

void AVoloOutputRoot::BeginPlaying(int64 Revision)
{
	if (SeqState == EVoloSeqState::Playing && SeqRevision == Revision)
	{
		return;
	}
	SeqT0 = GetWorld() ? GetWorld()->GetTimeSeconds() : 0.0;
	SeqState = EVoloSeqState::Playing;
	CurrentPlayIndex = -1;
	LogVolo(FString::Printf(TEXT("sequence start rev=%lld"), Revision));
}

bool AVoloOutputRoot::TryEmitStartIfReady(int64 Revision)
{
	const TArray<FString> All = GetClusterNodeIds();
	if (All.Num() == 0)
	{
		return false;
	}
	for (const FString& Id : All)
	{
		if (!ReadySet.Contains(Id))
		{
			return false;
		}
	}
	EmitStart(Revision);
	return true;
}

void AVoloOutputRoot::TickPlaying()
{
	if (!GetWorld() || Frames.Num() == 0 || SeqFps <= KINDA_SMALL_NUMBER)
	{
		ResetSequence(SeqRevision, TEXT("done"));
		return;
	}

	const double T = GetWorld()->GetTimeSeconds();
	const int32 Idx = FMath::FloorToInt32(static_cast<float>((T - SeqT0) * SeqFps));
	if (Idx < 0)
	{
		return;
	}
	if (Idx >= Frames.Num())
	{
		ResetSequence(SeqRevision, TEXT("done"));
		return;
	}
	if (Idx == CurrentPlayIndex)
	{
		return;
	}

	CurrentPlayIndex = Idx;
	ApplyShowTexture(Frames[Idx].Get(), SeqCropX, SeqCropY, SeqCropW, SeqCropH);
	// S3 sync evidence: eng alignment; Verbose to avoid per-frame Log spam.
	UE_LOG(LogTemp, Verbose, TEXT("VoloOutput: sequence frame rev=%lld idx=%d eng=%llu t=%.6f"),
		SeqRevision,
		Idx,
		static_cast<uint64>(GFrameCounter),
		T - SeqT0);
}

void AVoloOutputRoot::ResetSequence(int64 Revision, const TCHAR* Reason)
{
	ClearViewportReplace();
	Frames.Reset();
	ReadySet.Reset();
	SeqState = EVoloSeqState::Idle;
	CurrentPlayIndex = -1;
	LogVolo(FString::Printf(TEXT("sequence %s rev=%lld"), Reason, Revision));
}
