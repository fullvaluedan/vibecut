"use client";

/**
 * The properties dock's tab shell (R1/U1): "Properties | Director" so the Director
 * surface is always reachable, not just when a review takes over the inspector.
 * Both tabs stay MOUNTED at all times (hidden via CSS, not conditional rendering)
 * so DirectorCutPanel/DirectorHighlightPanel's applied-lock reactor registration
 * and row/filter state survive a tab switch (R1 lifecycle care): switching away
 * mid-"applied" and back must still reflect an intervening timeline edit as
 * "applied-locked", which only works if the panel never unmounts.
 */

import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowExpandIcon, ScissorIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/utils/ui";
import { PropertiesPanel } from "@/components/editor/panels/properties";
import { useAiActivityStore } from "@/features/ai-generate/ai-activity-store";
import { hasDirectorSession, shouldShowDirectorBadge } from "../dock-badge";
import { useDirectorPlanStore } from "../director-plan-store";
import { DirectorDock } from "./director-dock";

export function DirectorDockShell() {
	const dockTab = useDirectorPlanStore((s) => s.dockTab);
	const setDockTab = useDirectorPlanStore((s) => s.setDockTab);
	const plan = useDirectorPlanStore((s) => s.plan);
	const draft = useDirectorPlanStore((s) => s.draft);
	const keeps = useDirectorPlanStore((s) => s.keeps);
	const busy = useAiActivityStore((s) => s.label !== null);

	const showBadge = shouldShowDirectorBadge({
		dockTab,
		busy,
		hasSession: hasDirectorSession({ plan, draft, keeps }),
	});

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<TooltipProvider delayDuration={0}>
				<div className="flex shrink-0 items-center gap-0.5 border-b p-1">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant={dockTab === "properties" ? "secondary" : "ghost"}
								size="sm"
								onClick={() => setDockTab("properties")}
								className={cn(
									"h-7 gap-1.5 px-2 text-xs",
									dockTab !== "properties" && "text-muted-foreground",
								)}
							>
								<HugeiconsIcon icon={ArrowExpandIcon} size={14} />
								Properties
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">Selected element&apos;s properties</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant={dockTab === "director" ? "secondary" : "ghost"}
								size="sm"
								onClick={() => setDockTab("director")}
								className={cn(
									"relative h-7 gap-1.5 px-2 text-xs",
									dockTab !== "director" && "text-muted-foreground",
								)}
							>
								<HugeiconsIcon icon={ScissorIcon} size={14} />
								Director
								{showBadge ? (
									<span className="bg-primary absolute right-1 top-1 size-1.5 rounded-full" />
								) : null}
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">AI CUT actions &amp; review</TooltipContent>
					</Tooltip>
				</div>
			</TooltipProvider>
			<div
				className={cn(
					"min-h-0 flex-1",
					dockTab === "properties" ? "flex flex-col" : "hidden",
				)}
			>
				<PropertiesPanel />
			</div>
			<div
				className={cn(
					"min-h-0 flex-1",
					dockTab === "director" ? "flex flex-col" : "hidden",
				)}
			>
				<DirectorDock />
			</div>
		</div>
	);
}
