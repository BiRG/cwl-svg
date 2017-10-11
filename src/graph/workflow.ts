import {StepModel, WorkflowModel, WorkflowStepInputModel, WorkflowStepOutputModel} from "cwlts/models";
import {DomEvents}                                                                 from "../utils/dom-events";
import {EventHub}                                                                  from "../utils/event-hub";
import {Geometry}                                                                  from "../utils/geometry";
import {Edge as GraphEdge}                                                         from "./edge";
import {GraphNode}                                                                 from "./graph-node";
import {IOPort}                                                                    from "./io-port";
import {TemplateParser}                                                            from "./template-parser";
import {SVGPlugin}                                                                 from "../plugins/plugin";
import {Connectable}                                                               from "./connectable";
import {WorkflowInputParameterModel}                                               from "cwlts/models/generic/WorkflowInputParameterModel";
import {WorkflowOutputParameterModel}                                              from "cwlts/models/generic/WorkflowOutputParameterModel";

/**
 * @FIXME validation states of old and newly created edges
 */
export class Workflow {

    public static readonly minScale      = 0.2;
    public static readonly maxScale      = 2;
    public readonly eventHub: EventHub;
                           domEvents: DomEvents;
                           svgRoot: SVGSVGElement;
    /** Current scale of the document */
                           private scale = 1;

    workflow: SVGGElement;
    model: WorkflowModel;

    private workflowBoundingClientRect;

    private isDragging = false;

    private plugins: SVGPlugin[] = [];

    /**
     * The size of the workflow boundary / padding that stops nodes from being dragged
     * outside the workflow viewport; drag "scroll" is activated when cursor hits a boundary
     * @type {number}
     */
    private dragBoundary = 50;

    /**
     * The amount which the workflow, node, and necessary paths will be translated
     * when mouse is dragged on boundary or outside workflow every time the interval runs
     * @type {number}
     */
    private dragBoundaryTranslation = 5;

    /**
     * The interval that is set when the cursor hits a boundary (or multiple boundaries)
     * x and y represent the axes on which the boundary is hit, the interval is the interval
     * function itself, and xOffset and yOffset represent the accumulated translations
     */
    private dragBoundaryInterval = {
        x: false,
        y: false,
        interval: null,
        xOffset: 0,
        yOffset: 0,
        highlightedPort: undefined
    };

    graphData;

    /**
     * Disables dragging nodes, dragging from ports, arranging and deleting
     * @type {boolean}
     */
    private disableManipulations = false;

    private handlersThatCanBeDisabled = [];

    constructor(parameters: {
        svgRoot: SVGSVGElement,
        model: WorkflowModel,
        plugins?: SVGPlugin[]
    }) {
        let {svgRoot, model} = parameters;

        this.model     = model;
        this.svgRoot   = svgRoot;
        this.plugins   = parameters.plugins || [];
        this.domEvents = new DomEvents(this.svgRoot as any);

        this.hookPlugins();

        this.svgRoot.innerHTML = `
            <rect x="0" y="0" width="100%" height="100%" class="pan-handle" transform="matrix(1,0,0,1,0,0)"></rect>
            <g class="workflow" transform="matrix(1,0,0,1,0,0)"></g>
        `;

        this.workflow = this.svgRoot.querySelector(".workflow") as any;

        /**
         * Whenever user scrolls, take the scroll delta and scale the workflow.
         */
        this.svgRoot.addEventListener("mousewheel", (ev: MouseWheelEvent) => {
            if (this.isDragging) {
                return;
            }
            const scale = this.scale + ev.deltaY / 500;

            // Prevent scaling to unreasonable proportions.
            if (scale <= Workflow.minScale || scale >= Workflow.maxScale) {
                return;
            }

            this.scaleWorkflow(scale, ev);
            ev.stopPropagation();
        }, true);

        this.eventHub = new EventHub([
            /** @link connection.create */
            "connection.create",
            /** @link app.create.step */
            "app.create.step",
            /** @link app.create.input */
            "app.create.input",
            /** @link app.create.output */
            "app.create.output",
            /** @link workflow.fit */
            "beforeChange",
            "afterChange",
            "selectionChange"
        ]);

        this.attachEvents();

        if (model) {
            this.renderModel(model);
        }

    }

    static canDrawIn(element: SVGElement): boolean {
        let clientBounds = element.getBoundingClientRect();
        return clientBounds.width !== 0;
    }

    static findParentNode(el): SVGGElement | undefined {
        let parentNode = el;
        while (parentNode) {
            if (parentNode.classList.contains("node")) {
                return parentNode;
            }
            parentNode = parentNode.parentNode;
        }
    }

    findParentNode(el: Element): SVGGElement | undefined {
        return Workflow.findParentNode(el);
    }

    /**
     * Retrieves a plugin instance
     * @param {{new(...args: any[]) => T}} plugin
     * @returns {T}
     */
    getPlugin<T extends SVGPlugin>(plugin: { new(...args: any[]): T }): T | undefined {
        return this.plugins.find(p => p instanceof plugin) as T;
    }

    command(event: string, ...data: any[]) {
        this.eventHub.emit(event, ...data);
    }

    on(event: string, handler) {
        this.eventHub.on(event, handler);
    }

    off(event, handler) {
        this.eventHub.off(event, handler);
    }

    getScale() {
        return this.scale;
    }

    /**
     * Scales the workflow to fit the available viewport
     */
    fitToViewport(): void {

        this.scaleWorkflow(1);
        Object.assign(this.workflow.transform.baseVal.getItem(0).matrix, {
            e: 0,
            f: 0
        });

        let clientBounds = this.svgRoot.getBoundingClientRect();
        let wfBounds     = this.workflow.getBoundingClientRect();
        const padding    = 100;

        if (clientBounds.width === 0 || clientBounds.height === 0) {
            throw new Error("Cannot fit workflow to the area that has no visible viewport.");
        }

        const verticalScale   = (wfBounds.height) / (clientBounds.height - padding);
        const horizontalScale = (wfBounds.width) / (clientBounds.width - padding);

        const scaleFactor = Math.max(verticalScale, horizontalScale);

        // Cap the upscaling to 1, we don't want to zoom in workflows that would fit anyway
        const newScale = Math.min(this.scale / scaleFactor, 1);
        this.scaleWorkflow(newScale);

        const scaledWFBounds = this.workflow.getBoundingClientRect();

        const moveY = clientBounds.top - scaledWFBounds.top + Math.abs(clientBounds.height - scaledWFBounds.height) / 2;
        const moveX = clientBounds.left - scaledWFBounds.left + Math.abs(clientBounds.width - scaledWFBounds.width) / 2;

        const matrix = this.workflow.transform.baseVal.getItem(0).matrix;
        matrix.e += moveX;
        matrix.f += moveY;
    }

    redrawEdges() {

        const edgeEls          = this.model.connections.filter(el => el.isVisible);
        const highlightedEdges = new Set();

        Array.from(this.workflow.querySelectorAll(".edge")).forEach((el) => {
            if (el.classList.contains("highlighted")) {
                const edgeID = el.attributes["data-source-connection"].value + el.attributes["data-destination-connection"].value;
                highlightedEdges.add(edgeID);
            }
            el.remove();
        });


        const edgesTpl = this.model.connections
            .map(c => {
                const edgeId     = c.source.id + c.destination.id;
                const edgeStates = highlightedEdges.has(edgeId) ? "highlighted" : "";
                return GraphEdge.makeTemplate(c, this.workflow, edgeStates);
            })
            .reduce((acc, tpl) => acc + tpl, "");

        this.workflow.innerHTML = edgesTpl + this.workflow.innerHTML;
    }

    redraw(model?: WorkflowModel) {
        if (model) {
            this.model = model;
        }
        this.renderModel(this.model);
    }

    /**
     * Scale the workflow by the scaleCoefficient over the center of the workflo
     * @param scaleCoefficient
     */
    scaleWorkflowCenter(scaleCoefficient = 1) {
        this.workflowBoundingClientRect = this.svgRoot.getBoundingClientRect();
        this.scaleWorkflow(scaleCoefficient, {
            clientX: (this.workflowBoundingClientRect.right + this.workflowBoundingClientRect.left) / 2,
            clientY: (this.workflowBoundingClientRect.top + this.workflowBoundingClientRect.bottom) / 2
        });
    }

    /**
     * Scale the workflow by the scaleCoefficient (not compounded) over given coordinates
     * @param scaleCoefficient
     * @param ev
     */
    scaleWorkflow(scaleCoefficient = 1, ev?: { clientX: number, clientY: number }) {
        this.scale              = scaleCoefficient;
        const transform         = this.workflow.transform.baseVal;
        const matrix: SVGMatrix = transform.getItem(0).matrix;

        const coords = this.transformScreenCTMtoCanvas(ev ? ev.clientX : 0, ev ? ev.clientY : 0);

        matrix.e += matrix.a * coords.x;
        matrix.f += matrix.a * coords.y;
        matrix.a = matrix.d = scaleCoefficient;
        matrix.e -= scaleCoefficient * coords.x;
        matrix.f -= scaleCoefficient * coords.y;

        const labelScale = 1 + (1 - this.scale) / (this.scale * 2);

        Array.from(this.workflow.querySelectorAll(".node .label"))
            .map((el: SVGTextElement) => el.transform.baseVal.getItem(0).matrix)
            .forEach(m => {
                m.a = labelScale;
                m.d = labelScale;
            });
    }

    adaptToScale(x) {
        return x * (1 / this.scale);
    }

    public deselectEverything() {
        Array.from(this.workflow.querySelectorAll(".highlighted")).forEach(el => {
            el.classList.remove("highlighted");
        });
        this.workflow.classList.remove("has-selection");
        const selected = this.workflow.querySelector(".selected");
        if (selected) {
            selected.classList.remove("selected");
        }
        this.eventHub.emit("selectionChange", null);
    }

    public transformScreenCTMtoCanvas(x, y) {
        const svg   = this.svgRoot;
        const ctm   = this.workflow.getScreenCTM();
        const point = svg.createSVGPoint();
        point.x     = x;
        point.y     = y;

        const t = point.matrixTransform(ctm.inverse());
        return {
            x: t.x,
            y: t.y
        };
    }

    public deleteSelection() {

        const selection = Array.from(this.workflow.querySelectorAll(".selected"));
        if (selection.length == 0) {
            return;
        }

        const changeEventData = {
            type: "deletion",
            data: selection
        };
        this.eventHub.emit("beforeChange", changeEventData);

        selection.forEach(el => {
            if (el.classList.contains("step")) {

                this.model.removeStep(el.getAttribute("data-connection-id"));
                this.renderModel(this.model);
                (this.svgRoot as any).focus();
            } else if (el.classList.contains("edge")) {

                const sourcePortID      = el.getAttribute("data-source-connection");
                const destinationPortID = el.getAttribute("data-destination-connection");

                const sourcePort      = this.workflow.querySelector(`.port[data-connection-id="${sourcePortID}"]`);
                const destinationPort = this.workflow.querySelector(`.port[data-connection-id="${destinationPortID}"]`);

                const sourceNode      = Workflow.findParentNode(sourcePort);
                const destinationNode = Workflow.findParentNode(destinationPort);

                this.model.disconnect(sourcePortID, destinationPortID);
                this.renderModel(this.model);
                (this.svgRoot as any).focus();
            } else if (el.classList.contains("input")) {

                this.model.removeInput(el.getAttribute("data-connection-id"));
                this.renderModel(this.model);
                (this.svgRoot as any).focus();
            } else if (el.classList.contains("output")) {

                this.model.removeOutput(el.getAttribute("data-connection-id"));
                this.renderModel(this.model);
                (this.svgRoot as any).focus();
            }
        });

        this.eventHub.emit("selectionChange", null);

        this.eventHub.emit("afterChange", changeEventData);
    }

    setModelPosition(obj, x, y, emitEvents = true) {
        const update = {
            "sbg:x": x,
            "sbg:y": y
        };

        const changeEventData = {type: "move"};

        if (emitEvents) {
            this.eventHub.emit("beforeChange", changeEventData);
        }

        if (!obj.customProps) {
            obj.customProps = update;
            return;
        }

        Object.assign(obj.customProps, update);

        if (emitEvents) {
            this.eventHub.emit("afterChange", changeEventData);
        }
    }

    disableGraphManipulations() {
        this.disableManipulations = true;
        for (let i = 0; i < this.handlersThatCanBeDisabled.length; i++) {
            this.handlersThatCanBeDisabled[i]();
        }
    }

    enableGraphManipulations() {
        this.disableManipulations = false;
        this.attachSelectionDeletionBehavior();
    }

    destroy() {
        this.model.off("connection.create", this.onConnectionCreate);

        this.clearCanvas();
        this.eventHub.empty();
    }

    resetTransform() {
        this.workflow.setAttribute("transform", "matrix(1,0,0,1,0,0)");
        this.scaleWorkflow();
    }

    private renderModel(model: WorkflowModel) {
        console.time("Graph Rendering");
        this.model = model;

        // We will need to restore the transformations when we redraw the model, so save the current state
        const oldTransform = this.workflow.getAttribute("transform");

        // We might have an active selection that we want to preserve upon redrawing, save it
        let selectedStuff            = this.workflow.querySelector(".selected");
        let selectedItemConnectionID = selectedStuff ? selectedStuff.getAttribute("data-connection-id") : undefined;

        this.clearCanvas();

        this.workflow.setAttribute("transform", "matrix(1,0,0,1,0,0)");

        // If there is a missing sbg:x or sbg:y property on any node model,
        // the graph should be arranged to avoid random placement
        let arrangeNecessary = false;

        const nodes    = [...model.steps, ...model.inputs, ...model.outputs].filter(n => n.isVisible);
        const nodesTpl = nodes.map(n => GraphNode.patchModelPorts(n))
            .reduce((tpl, nodeModel: any) => {
                let x, y;

                if (!isNaN(parseInt(nodeModel.customProps["sbg:x"]))) {
                    x = nodeModel.customProps["sbg:x"];
                } else {
                    x                = 0;
                    arrangeNecessary = true;
                }

                if (!isNaN(parseInt(nodeModel.customProps["sbg:y"]))) {
                    y = nodeModel.customProps["sbg:y"];
                } else {
                    y                = 0;
                    arrangeNecessary = true;
                }

                return tpl + GraphNode.makeTemplate(nodeModel, x, y);
            }, "");

        this.workflow.innerHTML += nodesTpl;

        this.redrawEdges();
        console.timeEnd("Graph Rendering");
        console.time("Ordering");

        Array.from(this.workflow.querySelectorAll(".node")).forEach(e => {
            this.workflow.appendChild(e);
        });

        this.addEventListeners(this.svgRoot);

        this.workflow.setAttribute("transform", oldTransform);
        console.timeEnd("Ordering");

        if (arrangeNecessary) {
            // this.arrange();
        } else {
            this.scaleWorkflow(this.scale);
        }

        // If we had a selection before, restore it
        if (selectedItemConnectionID) {
            const newSelection = this.workflow.querySelector(`[data-connection-id='${selectedItemConnectionID}']`);
            // We need to check if the previously selected item still exist, since it might be deleted in the meantime
            if (newSelection) {
                this.activateSelection(newSelection as SVGGElement);
            }
        }

        this.invokePlugins("afterRender");


        // -- Newly added events for v0.1.0
        this.model.on("input.create", this.onInputCreate.bind(this));
        this.model.on("output.create", this.onOutputCreate.bind(this));
        this.model.on("connection.create", this.onConnectionCreate.bind(this));

    }

    private attachEvents() {

        this.model.on("step.change", (change: StepModel) => {
            const title = this.workflow.querySelector(`.node.step[data-id="${change.connectionId}"] .title`) as SVGTextElement;
            if (title) {
                title.textContent = change.label;
            }
        });

        /**
         * @name app.create.input
         */
        this.eventHub.on("app.create.input", (input: WorkflowStepInputModel) => {
            this.command("app.create.step", Object.assign(input, {
                out: [{
                    id: input.id,
                    connectionId: input.connectionId,
                    isVisible: true
                }]
            }))
        });

        /**
         * @name app.create.output
         */
        this.eventHub.on("app.create.output", (output: WorkflowStepOutputModel) => {
            this.command("app.create.step", Object.assign(output, {
                in: [{
                    id: output.id,
                    connectionId: output.connectionId,
                    isVisible: true
                }]
            }))
        });

        /**
         * @name app.create.step
         */
        this.eventHub.on("app.create.step", (step: StepModel) => {

            const changeEventData = {type: "step.create"};
            this.eventHub.emit("beforeChange", changeEventData);

            const x   = step.customProps["sbg:x"] || Math.random() * 1000;
            const y   = step.customProps["sbg:y"] || Math.random() * 1000;
            const tpl = GraphNode.makeTemplate(step, x, y);
            const el  = TemplateParser.parse(tpl);
            this.workflow.appendChild(el);

            // Labels on this new step will not be scaled properly since they are custom-adjusted during scaling
            // So let's trigger the scaling again
            this.scaleWorkflow(this.scale);

            this.eventHub.emit("afterChange", changeEventData);
        });

        this.model.on("connections.updated", (input: WorkflowStepInputModel) => {
            this.redrawEdges();
        });
    }

    private addEventListeners(root: SVGSVGElement): void {

        /**
         * Whenever a click happens on a blank space, remove selections
         */
        this.domEvents.on("click", "*", (ev, el, root) => {
            this.deselectEverything();
        });

        /**
         * Whenever a click happens on a node, select that node and
         * highlight all connecting edges and adjacent vertices
         * while shadowing others.
         */
        this.domEvents.on("click", ".node", (ev, el: SVGGElement) => {
            this.activateSelection(el);
        });

        /**
         * Attach canvas panning
         */
        {
            let pane: SVGGElement;
            let x;
            let y;
            let matrix: SVGMatrix;
            this.domEvents.drag(".pan-handle", (dx, dy, ev, el, root) => {

                matrix.e = x + dx;
                matrix.f = y + dy;

            }, (ev, el, root) => {
                pane   = root.querySelector(".workflow") as SVGGElement;
                matrix = pane.transform.baseVal.getItem(0).matrix;
                x      = matrix.e;
                y      = matrix.f;
            }, () => {
                pane   = undefined;
                matrix = undefined;
            });
        }

        /**
         * Edge Selection
         */
        this.domEvents.on("click", ".edge", (ev, target: SVGPathElement, root) => {
            this.highlightEdge(target);
            target.classList.add("selected");
        });

        /**
         * On mouse over node, bring it to the front
         */
        this.domEvents.on("mouseover", ".node", (ev, target, root) => {
            if (this.workflow.querySelector(".edge.dragged")) {
                return;
            }
            target.parentElement.appendChild(target);
        });

        if (!this.disableManipulations) {
            this.attachSelectionDeletionBehavior();
        }
    }

    /**
     * Sets the interval for dragging within a boundary zone if a new
     * boundary zone has been hit. The interval function translates the workflow,
     * the dragging node, and the edges attached to that node.
     * @param el
     * @param boundary
     * @param pathInfo
     * @param ghostIO
     */
    private setDragBoundaryIntervalIfNecessary(el: SVGGElement,
                                               boundary: { x: 1 | 0 | -1, y: 1 | 0 | -1 },
                                               pathInfo?: {
                                                   startX: number, startY: number,
                                                   inputEdges: Map<SVGElement, number[]>,
                                                   outputEdges: Map<SVGElement, number[]>
                                               },
                                               ghostIO?: {
                                                   edge: SVGPathElement,
                                                   nodeToMouseDistance: number,
                                                   connectionPorts: SVGGElement[],
                                                   highlightedPort: SVGGElement,
                                                   origin: { x: number, y: number },
                                                   coords: { x: number, y: number },
                                                   portToOriginTransformation: WeakMap<SVGGElement, SVGMatrix>,
                                                   edgeDirection: "left" | "right"
                                               }): void {

        // If boundary areas overlap or if boundary areas take up half - or more - of the svg, resize dragBoundary
        while (this.workflowBoundingClientRect.right - this.dragBoundary <= this.workflowBoundingClientRect.left + this.dragBoundary ||
        this.workflowBoundingClientRect.right <= this.workflowBoundingClientRect.left + (this.dragBoundary * 4)) {
            this.dragBoundary = this.dragBoundary / 2;
        }

        const checkIfLeftBoundary: boolean   = boundary.x === -1;
        const checkIfRightBoundary: boolean  = boundary.x === 1;
        const checkIfTopBoundary: boolean    = boundary.y === -1;
        const checkIfBottomBoundary: boolean = boundary.y === 1;

        if (boundary.x || boundary.y) {
            // If mouse has hit a boundary but 'this.dragBoundaryInterval' has not registered it yet,
            // or if both are registered - which happens in corner case - but mouse has been moved to
            // hit only one boundary afterwards
            if (!this.dragBoundaryInterval.x && boundary.x ||
                !this.dragBoundaryInterval.y && boundary.y ||
                (this.dragBoundaryInterval.x && this.dragBoundaryInterval.y && !(boundary.x && boundary.y))) {
                this.dragBoundaryInterval.x = boundary.x !== 0;
                this.dragBoundaryInterval.y = boundary.y !== 0;

                const workflowMatrix: SVGMatrix = this.workflow.transform.baseVal.getItem(0).matrix;
                const mx: SVGMatrix             = el.transform.baseVal.getItem(0).matrix;

                if (ghostIO) {
                    this.dragBoundaryInterval.highlightedPort = ghostIO.highlightedPort;
                }

                // Create new interval every time mouse hits new edge
                clearInterval(this.dragBoundaryInterval.interval);
                this.dragBoundaryInterval.interval = setInterval(() => {
                    const moveX = checkIfRightBoundary ? this.dragBoundaryTranslation :
                        checkIfLeftBoundary ? -this.dragBoundaryTranslation : 0;
                    const moveY = checkIfBottomBoundary ? this.dragBoundaryTranslation :
                        checkIfTopBoundary ? -this.dragBoundaryTranslation : 0;

                    // Change matrix e and f values - these represent x and y translate, respectively -
                    // by 'this.dragBoundaryTranslation' every time this function is called. This translates the matrix
                    // when the mouse down held on an edge.
                    workflowMatrix.e -= moveX;
                    workflowMatrix.f -= moveY;

                    this.dragBoundaryInterval.xOffset += this.adaptToScale(moveX);
                    this.dragBoundaryInterval.yOffset += this.adaptToScale(moveY);

                    // Translates the node by scaled 'moveX' (and/or 'moveY') every time
                    // this interval function is called.
                    mx.e += this.adaptToScale(moveX);
                    mx.f += this.adaptToScale(moveY);

                    // If node has edges - i.e. if it is not a ghost node
                    if (pathInfo) {
                        // Sets the paths correctly for the input edges and the output edges where necessary
                        this.setInputAndOutputEdges(pathInfo.inputEdges, pathInfo.outputEdges,
                            mx.e - pathInfo.startX, mx.f - pathInfo.startY);
                    }
                    else if (ghostIO) {
                        // Creates the ghost node path
                        Array.from(ghostIO.edge.children).forEach((el: SVGPathElement) => {
                            el.setAttribute("d",
                                IOPort.makeConnectionPath(
                                    ghostIO.origin.x,
                                    ghostIO.origin.y,
                                    mx.e,
                                    mx.f,
                                    ghostIO.edgeDirection
                                )
                            );
                        });

                        const sorted = this.getSortedConnectionPorts(ghostIO.connectionPorts,
                            {x: mx.e, y: mx.f}, ghostIO.portToOriginTransformation);
                        this.removeHighlightedPort(this.dragBoundaryInterval.highlightedPort, ghostIO.edgeDirection);
                        this.dragBoundaryInterval.highlightedPort = this.setHighlightedPort(sorted, ghostIO.edgeDirection);
                        this.translateGhostNodeAndShowIfNecessary(el, ghostIO.nodeToMouseDistance,
                            this.dragBoundaryInterval.highlightedPort !== undefined, {x: mx.e, y: mx.f});
                    }
                }, 1000 / 60);
            }
        }
    }

    /**
     * Check all possible workflow boundaries to see if (x,y) is on edge(s)
     * -1 / 1 values are left / right and top / bottom depending on the axis,
     * and 0 means it has not hit a boundary on that axis
     * @param x
     * @param y
     * @returns {{x: number, y: number}}
     */
    private getBoundaryZonesXYAxes(x: number, y: number): { x: 1 | 0 | -1, y: 1 | 0 | -1 } {
        const isLeftBoundary   = x < this.workflowBoundingClientRect.left + this.dragBoundary;
        const isRightBoundary  = x > this.workflowBoundingClientRect.right - this.dragBoundary;
        const isTopBoundary    = y < this.workflowBoundingClientRect.top + this.dragBoundary;
        const isBottomBoundary = y > this.workflowBoundingClientRect.bottom - this.dragBoundary;

        // if cursor is not on a boundary, then clear interval if it exists
        if (!isLeftBoundary && !isRightBoundary &&
            !isTopBoundary && !isBottomBoundary) {
            if (this.dragBoundaryInterval.interval) {
                clearInterval(this.dragBoundaryInterval.interval);
                this.dragBoundaryInterval.x = this.dragBoundaryInterval.y = false;
                this.dragBoundaryInterval.interval        = null;
                this.dragBoundaryInterval.highlightedPort = undefined;
            }
        }


        // return -1 if (x,y) is on left / top edge or outside the window on the left / top side,
        // return 1 if opposite, and 0 if cursor is in the main part of the canvas (standard), for each axis
        return {
            x: isLeftBoundary ? -1 : isRightBoundary ? 1 : 0,
            y: isTopBoundary ? -1 : isBottomBoundary ? 1 : 0
        };
    }

    /**
     * Calculates the change in x and y for drag, taking into account the starting x and y,
     * the cursor position, the boundary offsets, and the current scale coefficient.
     * @param boundary
     * @param ev
     * @param startX
     * @param startY
     * @param dx
     * @param dy
     * @returns {{x: number, y: number}}
     */
    private getScaledDeltaXYForDrag(boundary: { x: 1 | 0 | -1, y: 1 | 0 | -1 },
                                    ev: { clientX: number, clientY: number },
                                    startX: number, startY: number,
                                    dx: number, dy: number): { x: number, y: number } {
        const edgeIntervalOn = this.dragBoundaryInterval.interval !== null;
        let sdx, sdy;

        if (boundary.x !== 0 || boundary.y !== 0) {
            if (boundary.x !== 0) {
                const edgeX = this.transformScreenCTMtoCanvas(boundary.x === 1 ?
                    this.workflowBoundingClientRect.right - this.dragBoundary :
                    this.workflowBoundingClientRect.left + this.dragBoundary, 0).x; // CHANGE HERE
                sdx         = edgeX - startX;
            } else {
                sdx = this.adaptToScale(dx) + this.dragBoundaryInterval.xOffset;
            }
            if (boundary.y !== 0) {
                const edgeY = this.transformScreenCTMtoCanvas(0, boundary.y === 1 ?
                    this.workflowBoundingClientRect.bottom - this.dragBoundary :
                    this.workflowBoundingClientRect.top + this.dragBoundary).y; // CHANGE HERE
                sdy         = edgeY - startY;
            } else {
                sdy = this.adaptToScale(dy) + this.dragBoundaryInterval.yOffset;
            }

        } else {
            sdx = this.adaptToScale(dx) + this.dragBoundaryInterval.xOffset;
            sdy = this.adaptToScale(dy) + this.dragBoundaryInterval.yOffset;
        }
        return {
            x: sdx,
            y: sdy
        }
    }

    /**
     * Updates a node's input edges based on the node's output ports' locations,
     * and a node's output edges based on the node's input ports' locations
     * @param inputEdges
     * @param outputEdges
     * @param dx
     * @param dy
     */
    private setInputAndOutputEdges(inputEdges: Map<SVGElement, number[]>,
                                   outputEdges: Map<SVGElement, number[]>,
                                   dx: number,
                                   dy: number) {
        inputEdges.forEach((p: number[], el: SVGElement) => {
            el.setAttribute("d", IOPort.makeConnectionPath(p[0], p[1], p[6] + dx, p[7] + dy));
        });

        outputEdges.forEach((p, el) => {
            el.setAttribute("d", IOPort.makeConnectionPath(p[0] + dx, p[1] + dy, p[6], p[7]));
        });
    }

    private highlightEdge(el: SVGPathElement) {
        const sourceNode = el.getAttribute("data-source-node");
        const destNode   = el.getAttribute("data-destination-node");
        const sourcePort = el.getAttribute("data-source-port");
        const destPort   = el.getAttribute("data-destination-port");

        Array.from(this.workflow.querySelectorAll(
            `.node[data-id="${sourceNode}"] .output-port[data-port-id="${sourcePort}"], `
            + `.node[data-id="${destNode}"] .input-port[data-port-id="${destPort}"]`)).forEach(el => {
            el.classList.add("highlighted");
        });

        this.eventHub.emit("selectionChange", el);
    }


    private attachSelectionDeletionBehavior() {
        this.handlersThatCanBeDisabled.push(this.domEvents.on("keyup", (ev: KeyboardEvent) => {

            if (!(ev.target instanceof SVGElement)) {
                return;
            }

            if (ev.which !== 8) {
                return;
            }

            this.deleteSelection();
            // Only input elements can be focused, but we added tabindex to the svg so this works
        }, window));
    }

    /**
     * Goes through all the potential connection ports for a new path,
     * and sorts them by distance in ascending order
     * @param connectionPorts
     * @param portToOriginTransformation
     * @param transformationDisplacement
     * @param coords
     * @returns {SVGGElement[]}
     */
    private getSortedConnectionPorts(connectionPorts: SVGGElement[],
                                     coords: { x: number, y: number },
                                     portToOriginTransformation: WeakMap<SVGGElement, SVGMatrix>): Map<SVGGElement, number> {

        const distances: Map<SVGGElement, number> = new Map();
        const ordered: Map<SVGGElement, number>   = new Map();

        connectionPorts.forEach(el => {
            const ctm = portToOriginTransformation.get(el);
            distances.set(el, Geometry.distance(coords.x, coords.y, ctm.e, ctm.f));
        });

        connectionPorts.sort((el1, el2) => distances.get(el1) - distances.get(el2)).forEach(el => {
            ordered.set(el, distances.get(el));
        });

        return ordered;
    }

    /**
     * Removes highlighted port if a highlighted port exists
     * @param highlightedPort
     * @param edgeDirection
     */
    private removeHighlightedPort(highlightedPort: SVGGElement, edgeDirection: "left" | "right"): void {
        if (highlightedPort) {
            const parentNode = Workflow.findParentNode(highlightedPort);
            // highlightedPort.classList.remove("highlighted", "preferred-port");
            highlightedPort.classList.remove("highlighted", "preferred-port");
            // parentNode.classList.remove("highlighted", "preferred-node", edgeDirection);
            parentNode.classList.remove("preferred-node", edgeDirection);
        }
    }

    /**
     * Check if the closest connection port is within a certain distance.
     * If it is, highlight it and return the highlightedPort
     * @param sortedMap
     * @param edgeDirection
     * @returns {any}
     */
    private setHighlightedPort(sortedMap: Map<SVGGElement, number>, edgeDirection: "left" | "right"): SVGGElement {
        let highlightedPort;

        const portElements = Array.from(sortedMap.keys());
        // If there is a port in close proximity, assume that we want to connect to it, so highlight it
        if (portElements.length && sortedMap.get(portElements[0]) < 100) {
            highlightedPort = portElements[0];
            highlightedPort.classList.add("highlighted", "preferred-port");
            const parentNode = Workflow.findParentNode(highlightedPort);
            this.workflow.appendChild(parentNode);
            parentNode.classList.add("highlighted", "preferred-node", edgeDirection);
        } else {
            highlightedPort = undefined;
        }
        return highlightedPort;
    }

    /**
     * Translate the ghost node and show it if the closest connection
     * port is farther than 120px
     * @param ghostIONode
     * @param nodeToMouseDistance
     * @param newCoords
     */
    private translateGhostNodeAndShowIfNecessary(ghostIONode: SVGGElement,
                                                 nodeToMouseDistance: number,
                                                 isCloseToPort: boolean,
                                                 newCoords: { x: number, y: number }): void {
        ghostIONode.classList.add("hidden");
        if (nodeToMouseDistance > 120 && !isCloseToPort) {
            ghostIONode.classList.remove("hidden");
            // Otherwise, we might create an input or an ooutput node
        }
        ghostIONode.transform.baseVal.getItem(0).setTranslate(newCoords.x, newCoords.y);
    }

    /**
     * Sets the dragBoundaryInterval object to its default values
     */
    private setDragBoundaryIntervalToDefault(): void {
        if (this.dragBoundaryInterval.interval) {
            clearInterval(this.dragBoundaryInterval.interval);
            this.dragBoundaryInterval.x = this.dragBoundaryInterval.y = false;
            this.dragBoundaryInterval.interval        = null;
            this.dragBoundaryInterval.highlightedPort = undefined;
        }
        this.dragBoundaryInterval.xOffset = this.dragBoundaryInterval.yOffset = 0;
    }

    private clearCanvas() {
        this.domEvents.detachAll();
        this.workflow.innerHTML = "";
        this.workflow.setAttribute("class", "workflow");
    }

    private getOffsetFromCanvasCenter(x, y) {

        const abs = {
            x: x - this.svgRoot.clientWidth / 2,
            y: y - this.svgRoot.clientHeight / 2,
        };
        const pc  = {
            pcx: abs.x / this.svgRoot.clientWidth,
            pcy: abs.y / this.svgRoot.clientHeight
        };

        return {...abs, ...pc};
    }

    private activateSelection(el: SVGGElement) {
        this.deselectEverything();

        this.workflow.classList.add("has-selection");

        const nodeID = el.getAttribute("data-id");

        const firstNode = this.workflow.getElementsByClassName("node")[0];
        Array.from(this.workflow.querySelectorAll(`.edge[data-source-node="${nodeID}"], .edge[data-destination-node="${nodeID}"]`)).forEach((edge: HTMLElement) => {
            edge.classList.add("highlighted");
            const sourceNodeID      = edge.getAttribute("data-source-node");
            const destinationNodeID = edge.getAttribute("data-destination-node");

            Array.from(this.workflow.querySelectorAll(`.node[data-id="${sourceNodeID}"], .node[data-id="${destinationNodeID}"]`))
                .forEach((el: SVGGElement) => el.classList.add("highlighted"));

            this.workflow.insertBefore(edge, firstNode);
        });

        el.classList.add("selected");
        if (typeof (el as any).focus === "function") {
            (el as any).focus();
        }
        this.eventHub.emit("selectionChange", el);
    }

    private hookPlugins() {

        this.plugins.forEach(plugin => {
            plugin.registerWorkflowModel(this);

            plugin.registerOnBeforeChange(event => {
                this.eventHub.emit("beforeChange", event);
            });

            plugin.registerOnAfterChange(event => {
                this.eventHub.emit("afterChange", event);
            });
        });
    }

    private invokePlugins(methodName: keyof SVGPlugin, ...args: any[]) {
        this.plugins.forEach(plugin => {
            if (typeof plugin[methodName] === "function") {
                (plugin[methodName] as Function)(...args);
            }
        })
    }

    static makeConnectionPath(x1, y1, x2, y2, forceDirection: "right" | "left" | string = "right"): string {

        if (!forceDirection) {
            return `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1} ${(x1 + x2) / 2} ${y2} ${x2} ${y2}`;
        } else if (forceDirection === "right") {
            const outDir = x1 + Math.abs(x1 - x2) / 2;
            const inDir  = x2 - Math.abs(x1 - x2) / 2;

            return `M ${x1} ${y1} C ${outDir} ${y1} ${inDir} ${y2} ${x2} ${y2}`;
        } else if (forceDirection === "left") {
            const outDir = x1 - Math.abs(x1 - x2) / 2;
            const inDir  = x2 + Math.abs(x1 - x2) / 2;

            return `M ${x1} ${y1} C ${outDir} ${y1} ${inDir} ${y2} ${x2} ${y2}`;
        }
    }

    /**
     * Listener for “connection.create” event on model that renders new edges on canvas
     */
    private onConnectionCreate(source: Connectable, destination: Connectable): void {

        const sourceID      = source.connectionId;
        const destinationID = destination.connectionId;

        GraphEdge.spawnBetweenConnectionIDs(this.workflow, sourceID, destinationID);

    }

    /**
     * Listener for “input.create” event on model that renders workflow inputs
     */
    private onInputCreate(input: WorkflowInputParameterModel): void {

        const patched       = GraphNode.patchModelPorts(input);
        const graphTemplate = GraphNode.makeTemplate(patched);

        const el = TemplateParser.parse(graphTemplate);
        this.workflow.appendChild(el);

    }

    /**
     * Listener for “output.create” event on model that renders workflow outputs
     */
    private onOutputCreate(output: WorkflowOutputParameterModel): void {

        const patched       = GraphNode.patchModelPorts(output);
        const graphTemplate = GraphNode.makeTemplate(patched);

        const el = TemplateParser.parse(graphTemplate);
        this.workflow.appendChild(el);
    }

}