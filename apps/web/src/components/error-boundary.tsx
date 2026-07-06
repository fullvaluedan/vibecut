"use client";

import React from "react";
import { Button } from "@/components/ui/button";

/**
 * Last-line crash guard for the editor. A render/lifecycle error anywhere in
 * the tree used to white-screen the whole app with zero explanation; this
 * catches it and shows a recovery screen instead. Projects persist to
 * IndexedDB as you edit, so a reload is safe — the copy says so, because the
 * user's first fear at a crash screen is lost work.
 */
interface ErrorBoundaryState {
	error: Error | null;
	componentStack: string;
}

export class EditorErrorBoundary extends React.Component<
	{ children: React.ReactNode },
	ErrorBoundaryState
> {
	state: ErrorBoundaryState = { error: null, componentStack: "" };

	static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
		return { error };
	}

	componentDidCatch(error: Error, info: React.ErrorInfo): void {
		this.setState({ componentStack: info.componentStack ?? "" });
		console.error("[editor] crashed:", error, info.componentStack);
	}

	private copyDetails = () => {
		const { error, componentStack } = this.state;
		const details = [
			"VibeCut crash report",
			`When: ${new Date().toISOString()}`,
			`Message: ${error?.message ?? "Unknown"}`,
			error?.stack ? `Stack:\n${error.stack}` : null,
			componentStack ? `Component stack:\n${componentStack}` : null,
		]
			.filter(Boolean)
			.join("\n");
		void navigator.clipboard.writeText(details);
	};

	render() {
		const { error } = this.state;
		if (!error) return this.props.children;

		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex max-w-lg flex-col gap-4 rounded-lg border p-8">
					<h1 className="text-lg font-semibold">
						The editor hit an error it couldn't recover from
					</h1>
					<p className="text-muted-foreground text-sm">
						Your project is saved locally as you edit, so reloading is safe.
						If this keeps happening, copy the details and report it.
					</p>
					<p className="bg-muted text-muted-foreground max-h-24 overflow-auto rounded p-2 font-mono text-xs">
						{error.message}
					</p>
					<div className="flex items-center gap-2">
						<Button onClick={() => window.location.reload()}>
							Reload editor
						</Button>
						<Button variant="secondary" onClick={this.copyDetails}>
							Copy details
						</Button>
						<Button variant="ghost" asChild>
							<a href="/projects">Back to projects</a>
						</Button>
					</div>
				</div>
			</div>
		);
	}
}
