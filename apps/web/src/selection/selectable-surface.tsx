"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SelectionBox } from "@/selection/selection-box";
import { SelectionContext } from "@/selection/context";
import { SELECTABLE_ITEM_ATTRIBUTE } from "@/selection/attributes";
import { resolveElementIntersections } from "@/selection/hit-testing";
import {
	applyBoxSelection,
	clearSelection,
	isSelected as getIsSelected,
	pruneSelection,
	replaceSelection,
	selectRange,
	toggleSelection,
} from "@/selection/state";
import type {
	SelectableSurfaceProps,
	SelectionState,
} from "@/selection/types";
import { useBoxSelect } from "@/selection/hooks/use-box-select";
import { cn } from "@/utils/ui";

export function SelectableSurface({
	orderedIds,
	children,
	className,
	ariaLabel = "Selectable items",
	revealId = null,
	onRevealComplete,
	onSelectionChange,
}: SelectableSurfaceProps) {
	const [selectionState, setSelectionState] = useState<SelectionState>(() =>
		clearSelection(),
	);
	const [highlightedId, setHighlightedId] = useState<string | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const itemElementsRef = useRef<Map<string, HTMLElement>>(new Map());

	const registerItem = useCallback(
		(id: string, element: HTMLElement | null) => {
			if (element) {
				itemElementsRef.current.set(id, element);
			} else {
				itemElementsRef.current.delete(id);
			}
		},
		[],
	);

	const getSelectableElements = useCallback(() => {
		return itemElementsRef.current;
	}, []);

	const getItemElement = useCallback((id: string) => {
		return itemElementsRef.current.get(id) ?? null;
	}, []);
	const shouldStartSelection = useCallback(
		(event: React.MouseEvent<Element>) => {
			return !(
				event.target instanceof Element &&
				event.target.closest(`[${SELECTABLE_ITEM_ATTRIBUTE}='true']`)
			);
		},
		[],
	);
	const resolveIntersections = useCallback(
		({
			startPos,
			currentPos,
		}: {
			startPos: { x: number; y: number };
			currentPos: { x: number; y: number };
		}) => {
			return resolveElementIntersections({
				startPos,
				currentPos,
				elements: getSelectableElements(),
			});
		},
		[getSelectableElements],
	);

	const clearSelectionState = useCallback(() => {
		setSelectionState(clearSelection());
	}, []);

	const selectAll = useCallback(() => {
		if (orderedIds.length === 0) return;
		setSelectionState(
			replaceSelection({
				ids: orderedIds,
				anchorId: orderedIds[orderedIds.length - 1] ?? null,
			}),
		);
	}, [orderedIds]);

	const selectedIdSet = useMemo(
		() => new Set(selectionState.selectedIds),
		[selectionState.selectedIds],
	);

	const isSelected = useCallback(
		(id: string) => selectedIdSet.has(id),
		[selectedIdSet],
	);

	const handleItemClick = useCallback(
		({
			event,
			id,
		}: {
			event:
				| React.MouseEvent<HTMLDivElement>
				| React.KeyboardEvent<HTMLDivElement>;
			id: string;
		}) => {
			setSelectionState((state) => {
				const isToggleSelection = event.ctrlKey || event.metaKey;

				if (event.shiftKey) {
					return selectRange({
						state,
						orderedIds,
						targetId: id,
						isAdditive: isToggleSelection,
					});
				}

				if (isToggleSelection) {
					return toggleSelection({
						state,
						id,
					});
				}

				return replaceSelection({
					ids: [id],
					anchorId: id,
				});
			});
		},
		[orderedIds],
	);

	const selectUnselectedItem = useCallback((id: string) => {
		setSelectionState((state) => {
			if (getIsSelected({ state, id })) {
				return state;
			}

			return replaceSelection({ ids: [id], anchorId: id });
		});
	}, []);

	const handleItemMouseDown = useCallback(
		({
			event,
			id,
		}: {
			event: React.MouseEvent<HTMLDivElement>;
			id: string;
		}) => {
			if (event.button !== 2) {
				return;
			}

			selectUnselectedItem(id);
		},
		[selectUnselectedItem],
	);

	const handleBoxSelectionChange = useCallback(
		(change: Parameters<typeof applyBoxSelection>[0]) => {
			setSelectionState(applyBoxSelection(change));
		},
		[],
	);

	const { selectionBox, handleMouseDown, isSelecting, shouldIgnoreClick } =
		useBoxSelect({
			containerRef,
			resolveIntersections,
			selectedIds: selectionState.selectedIds,
			anchorId: selectionState.anchorId,
			onSelectionChange: handleBoxSelectionChange,
			shouldStartSelection,
		});

	const handleBackgroundClick = useCallback(
		(event: React.MouseEvent<HTMLDivElement>) => {
			const clickedSelectableItem =
				event.target instanceof Element &&
				event.target.closest(`[${SELECTABLE_ITEM_ATTRIBUTE}='true']`);
			const isIgnoringClick = shouldIgnoreClick();
			if (clickedSelectableItem || isIgnoringClick) {
				return;
			}

			clearSelectionState();
		},
		[clearSelectionState, shouldIgnoreClick],
	);

	const handleBackgroundKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			if (event.target !== event.currentTarget) {
				return;
			}

			if (event.key !== "Enter" && event.key !== " " && event.key !== "Escape") {
				return;
			}

			event.preventDefault();
			clearSelectionState();
		},
		[clearSelectionState],
	);

	useEffect(() => {
		setSelectionState((state) =>
			pruneSelection({
				state,
				orderedIds,
			}),
		);
	}, [orderedIds]);

	// Ctrl/Cmd+A selects every item in THIS surface — but only when focus is
	// within it, so the global (timeline) select-all still wins elsewhere. The
	// window-capture listener fires before the document-capture keybinding
	// dispatcher, and stopPropagation keeps the global handler from also running.
	useEffect(() => {
		const handleSelectAll = (event: KeyboardEvent) => {
			if (event.key !== "a" && event.key !== "A") return;
			if (!(event.ctrlKey || event.metaKey)) return;
			if (event.shiftKey || event.altKey) return;
			const container = containerRef.current;
			const active = document.activeElement;
			if (!container || !active || !container.contains(active)) return;
			if (
				active instanceof HTMLElement &&
				(active.tagName === "INPUT" ||
					active.tagName === "TEXTAREA" ||
					active.isContentEditable)
			) {
				return;
			}
			if (orderedIds.length === 0) return;
			event.preventDefault();
			event.stopPropagation();
			selectAll();
		};

		window.addEventListener("keydown", handleSelectAll, { capture: true });
		return () =>
			window.removeEventListener("keydown", handleSelectAll, { capture: true });
	}, [orderedIds, selectAll]);

	useEffect(() => {
		onSelectionChange?.(selectionState);
	}, [onSelectionChange, selectionState]);

	useEffect(() => {
		if (!revealId) {
			return;
		}

		setHighlightedId(revealId);
		getItemElement(revealId)?.scrollIntoView({ block: "center" });

		const timer = setTimeout(() => {
			setHighlightedId(null);
			onRevealComplete?.();
		}, 1500);

		return () => clearTimeout(timer);
	}, [getItemElement, onRevealComplete, revealId]);

	const isBoxSelecting = isSelecting;

	const contextValue = useMemo(() => {
		return {
			selectedIds: selectionState.selectedIds,
			anchorId: selectionState.anchorId,
			highlightedId,
			isBoxSelecting,
			isSelected,
			clearSelection: clearSelectionState,
			handleItemClick,
			handleItemMouseDown,
			registerItem,
		};
	}, [
		clearSelectionState,
		handleItemClick,
		handleItemMouseDown,
		highlightedId,
		isBoxSelecting,
		isSelected,
		registerItem,
		selectionState.anchorId,
		selectionState.selectedIds,
	]);

	return (
		<SelectionContext.Provider value={contextValue}>
			<div
				ref={containerRef}
				className={cn("relative min-h-full", className)}
				role="listbox"
				aria-label={ariaLabel}
				aria-multiselectable="true"
				tabIndex={0}
				onMouseDown={handleMouseDown}
				onClick={handleBackgroundClick}
				onKeyDown={handleBackgroundKeyDown}
			>
				{children}
				<SelectionBox bounds={selectionBox?.bounds ?? null} />
			</div>
		</SelectionContext.Provider>
	);
}
