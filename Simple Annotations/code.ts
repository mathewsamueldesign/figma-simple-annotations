figma.showUI(__html__, { width: 340, height: 480 });

function hexToRgb(hex: string): RGB {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16) / 255,
    g: parseInt(result[2], 16) / 255,
    b: parseInt(result[3], 16) / 255
  } : { r: 1, g: 0, b: 0 };
}

interface AnnotationItem {
  id: string;
  title: string;
  desc: string;
  color: string;
}

interface AnnotationData {
  connectorColor: string;
  items: AnnotationItem[];
  targetNodeId?: string;
}

const FONT_REGULAR = { family: "Inter", style: "Regular" };
const FONT_BOLD = { family: "Inter", style: "Bold" };

// Check selection and update UI state
figma.on('selectionchange', () => {
  const selection = figma.currentPage.selection;
  if (selection.length === 1) {
    let node = selection[0];

    // If user selects the wrapping group, dig inside to find the annotation frame
    if (node.type === 'GROUP') {
      const frames = node.findChildren(n => n.type === 'FRAME' && !!n.getPluginData('annotationData'));
      if (frames.length > 0) {
        node = frames[0] as SceneNode;
      }
    }

    const dataString = node.getPluginData('annotationData');
    if (dataString) {
      try {
        const data = JSON.parse(dataString);
        figma.ui.postMessage({ type: 'set-state', mode: 'edit', data });
        return;
      } catch (e) {
        console.error("Failed to parse annotation data", e);
      }
    }
  }

  // If no single annotation is selected, default to create mode
  figma.ui.postMessage({ type: 'set-state', mode: 'create' });
});

// Auto-update connectors when moving things
// Figma requires loadAllPagesAsync before registering documentchange
(async () => {
  await figma.loadAllPagesAsync();
  figma.on('documentchange', (event) => {
    let needsUpdate = false;
    for (const change of event.documentChanges) {
      if (change.type === 'PROPERTY_CHANGE' && change.properties) {
        const p = change.properties;
        if (p.indexOf('x') !== -1 || p.indexOf('y') !== -1 || p.indexOf('width') !== -1 || p.indexOf('height') !== -1) {
          needsUpdate = true;
        }

        // Handle Manual Text Edits mapping back to Plugin Data
        if (p.indexOf('characters') !== -1 && change.node.type === 'TEXT') {
          const textNode = change.node as TextNode;
          if (textNode.name === 'Title' || textNode.name === 'Description') {
            // Traverse up to find the Annotation Note
            let parent = textNode.parent;
            let itemRow = null;
            let annotationFrame = null;

            while (parent && parent.type !== 'PAGE') {
              if (parent.name === 'Item Row') itemRow = parent;
              if (parent.type === 'FRAME' && parent.getPluginData('annotationData')) {
                annotationFrame = parent as FrameNode;
                break;
              }
              parent = parent.parent;
            }

            if (annotationFrame && itemRow) {
              const dataStr = annotationFrame.getPluginData('annotationData');
              if (dataStr) {
                try {
                  const data = JSON.parse(dataStr) as AnnotationData;
                  // All Item Rows are children of Annotation Note, offset by possible lines/dots if grouped differently,
                  // but we can just filter by 'Item Row' to find the index.
                  const rowChildren = annotationFrame.children.filter(c => c.name === 'Item Row');
                  const itemIndex = rowChildren.findIndex(r => r.id === itemRow!.id);

                  if (itemIndex > -1 && data.items[itemIndex]) {
                    if (textNode.name === 'Title') {
                      data.items[itemIndex].title = textNode.characters;
                    } else if (textNode.name === 'Description') {
                      data.items[itemIndex].desc = textNode.characters;
                    }

                    // Save and re-sync
                    annotationFrame.setPluginData('annotationData', JSON.stringify(data));

                    // If this frame is currently selected, update the UI side too
                    const selection = figma.currentPage.selection;
                    if (selection.length === 1 && selection[0].id === annotationFrame.id) {
                      figma.ui.postMessage({ type: 'set-state', mode: 'edit', data });
                    }
                  }
                } catch (e) {
                  console.error("Failed to sync text change", e);
                }
              }
            }
          }
        }
      }
    }
    if (needsUpdate) {
      const annotationFrames = figma.currentPage.findAllWithCriteria({ pluginData: { keys: ['annotationData'] } });
      for (const frame of annotationFrames) {
        if (frame.type === 'FRAME') {
          const dataStr = frame.getPluginData('annotationData');
          if (dataStr) {
            try {
              const data = JSON.parse(dataStr);
              if (data.targetNodeId) {
                updateConnector(frame as FrameNode, data);
              }
            } catch (e) { }
          }
        }
      }
    }
  });
})();

async function updateConnector(frame: FrameNode, data: AnnotationData) {
  try {
    if (!data.targetNodeId) return;
    const targetNode = await figma.getNodeByIdAsync(data.targetNodeId) as SceneNode;

    const lineId = frame.getPluginData('connectorLineId');
    const dotId = frame.getPluginData('connectorDotId');
    let line = lineId ? await figma.getNodeByIdAsync(lineId) as VectorNode : null;
    let dot = dotId ? await figma.getNodeByIdAsync(dotId) as EllipseNode : null;

    if (!targetNode) {
      if (line) line.visible = false;
      if (dot) dot.visible = false;
      return;
    }
    if (line) line.visible = true;
    if (dot) dot.visible = true;

    // Destroy stray ConnectorNode if we previously generated one by accident
    if (line && (line as any).type === 'CONNECTOR') { line.remove(); line = null; }
    if (dot && (dot as any).type === 'CONNECTOR') { dot.remove(); dot = null; }

    const targetBounds = targetNode.absoluteBoundingBox;
    const frameBounds = frame.absoluteBoundingBox;
    if (!targetBounds || !frameBounds) return;

    const tCenterX = targetBounds.x + targetBounds.width / 2;
    const tCenterY = targetBounds.y + targetBounds.height / 2;
    const fCenterX = frameBounds.x + frameBounds.width / 2;
    const fCenterY = frameBounds.y + frameBounds.height / 2;

    let startX = 0, startY = 0, endX = 0, endY = 0;
    let isHorizontal = Math.abs(tCenterX - fCenterX) > Math.abs(tCenterY - fCenterY);

    if (isHorizontal) {
      if (fCenterX > tCenterX) {
        // Frame is to the right
        startX = frameBounds.x;
        startY = fCenterY;
        endX = targetBounds.x + targetBounds.width;
        endY = tCenterY;
      } else {
        // Frame is to the left
        startX = frameBounds.x + frameBounds.width;
        startY = fCenterY;
        endX = targetBounds.x;
        endY = tCenterY;
      }
    } else {
      if (fCenterY > tCenterY) {
        // Frame is below
        startX = fCenterX;
        startY = frameBounds.y;
        endX = tCenterX;
        endY = targetBounds.y + targetBounds.height;
      } else {
        // Frame is above
        startX = fCenterX;
        startY = frameBounds.y + frameBounds.height;
        endX = tCenterX;
        endY = targetBounds.y;
      }
    }

    // Convert absolute coordinates into local coordinates relative to the frame
    const lStartX = startX - frameBounds.x;
    const lStartY = startY - frameBounds.y;
    const lEndX = endX - frameBounds.x;
    const lEndY = endY - frameBounds.y;

    const minX = Math.min(lStartX, lEndX);
    const minY = Math.min(lStartY, lEndY);
    const pStartX = lStartX - minX;
    const pStartY = lStartY - minY;
    const pEndX = lEndX - minX;
    const pEndY = lEndY - minY;

    // We want the 'bus' elbows to run completely outside the parent container (e.g. the main artboard)
    let topParent: BaseNode = targetNode;
    while (topParent.parent && topParent.parent.type !== 'PAGE') {
      topParent = topParent.parent;
    }
    const parentBounds = 'absoluteBoundingBox' in topParent ? topParent.absoluteBoundingBox : null;

    const allFrames = figma.currentPage.findAllWithCriteria({ pluginData: { keys: ['annotationData'] } });

    let pathData;
    if (isHorizontal) {
      allFrames.sort((a, b) => a.y - b.y);
      const frameIndex = allFrames.findIndex(f => f.id === frame.id);

      const invertedIndex = Math.max(0, allFrames.length - 1 - frameIndex);
      const staggerOffset = invertedIndex * 12;

      let midX;
      if (pEndX < pStartX) {
        // Annotation is right of button. Route bus to the right of the parent frame
        const parentRightX = parentBounds ? parentBounds.x + parentBounds.width : targetBounds.x + targetBounds.width;
        // Convert the absolute parent edge to local coords for our SVG
        const localParentRightX = parentRightX - frameBounds.x - minX;
        midX = localParentRightX + 24 + staggerOffset;
      } else {
        // Annotation is left of button. Route bus to the left of the parent frame
        const parentLeftX = parentBounds ? parentBounds.x : targetBounds.x;
        const localParentLeftX = parentLeftX - frameBounds.x - minX;
        midX = localParentLeftX - 24 - staggerOffset;
      }

      pathData = `M ${pStartX} ${pStartY} L ${midX} ${pStartY} L ${midX} ${pEndY} L ${pEndX} ${pEndY}`;
    } else {
      allFrames.sort((a, b) => a.x - b.x);
      const frameIndex = allFrames.findIndex(f => f.id === frame.id);

      const invertedIndex = Math.max(0, allFrames.length - 1 - frameIndex);
      const staggerOffset = invertedIndex * 12;

      let midY;
      if (pEndY < pStartY) {
        // Annotation is below the button. Route the bus below the parent frame.
        const parentBottomY = parentBounds ? parentBounds.y + parentBounds.height : targetBounds.y + targetBounds.height;
        const localParentBottomY = parentBottomY - frameBounds.y - minY;
        midY = localParentBottomY + 24 + staggerOffset;
      } else {
        // Annotation is above the button. Route the bus above the parent frame
        const parentTopY = parentBounds ? parentBounds.y : targetBounds.y;
        const localParentTopY = parentTopY - frameBounds.y - minY;
        midY = localParentTopY - 24 - staggerOffset;
      }

      pathData = `M ${pStartX} ${pStartY} L ${pStartX} ${midY} L ${pEndX} ${midY} L ${pEndX} ${pEndY}`;
    }

    if (!line || line.type !== 'VECTOR') {
      line = figma.createVector();
      line.name = "↳ Connector Line";
      frame.appendChild(line);
      line.layoutPositioning = "ABSOLUTE";
      frame.setPluginData('connectorLineId', line.id);
    }

    if (line.vectorPaths.length === 0 || line.vectorPaths[0].data !== pathData) {
      line.vectorPaths = [{ windingRule: 'EVENODD', data: pathData }];
    }
    if (line.x !== minX) line.x = minX;
    if (line.y !== minY) line.y = minY;
    line.strokeWeight = 2;
    line.dashPattern = [4, 4];
    line.strokes = [{ type: 'SOLID', color: hexToRgb(data.connectorColor) }];
    line.fills = [];

    if (!dot || dot.type !== 'ELLIPSE') {
      dot = figma.createEllipse();
      dot.name = "Connector End";
      dot.resize(10, 10);
      frame.appendChild(dot);
      dot.layoutPositioning = "ABSOLUTE";
      frame.setPluginData('connectorDotId', dot.id);
    }

    const dotX = lEndX - dot.width / 2;
    const dotY = lEndY - dot.height / 2;

    if (dot.x !== dotX) dot.x = dotX;
    if (dot.y !== dotY) dot.y = dotY;
    dot.fills = [{ type: 'SOLID', color: hexToRgb(data.connectorColor) }];
    dot.strokes = [];
    dot.strokeWeight = 0;

    // Send lines to the back of the frame, behind the actual annotation rows
    if (line.parent === frame) frame.insertChild(0, line);
    if (dot.parent === frame) frame.insertChild(1, dot);

  } catch (err) {
    figma.notify("Connector Drawing Error: " + (err as Error).message);
    console.error(err);
  }
}

async function buildAnnotationContent(parentFrame: FrameNode, data: AnnotationData) {
  // Clear existing children (for edit mode)
  parentFrame.children.forEach(c => c.remove());

  await figma.loadFontAsync(FONT_REGULAR);
  await figma.loadFontAsync(FONT_BOLD);

  // Group container styling 
  parentFrame.clipsContent = false;
  parentFrame.layoutMode = "VERTICAL";
  parentFrame.paddingTop = 16;
  parentFrame.paddingBottom = 16;
  parentFrame.paddingLeft = 16;
  parentFrame.paddingRight = 16;
  parentFrame.itemSpacing = 16;
  parentFrame.cornerRadius = 8;
  parentFrame.fills = [{ type: 'SOLID', color: hexToRgb('#2A2A2A') }];
  parentFrame.strokes = [{ type: 'SOLID', color: hexToRgb('#444444') }];
  parentFrame.strokeWeight = 1;
  parentFrame.primaryAxisSizingMode = "AUTO";
  parentFrame.counterAxisSizingMode = "FIXED";
  parentFrame.layoutAlign = "MIN";
  parentFrame.resize(300, parentFrame.height);

  for (const item of data.items) {
    const itemRow = figma.createFrame();
    itemRow.name = "Item Row";
    itemRow.layoutMode = "VERTICAL";
    itemRow.itemSpacing = 8;
    itemRow.fills = [];
    itemRow.primaryAxisSizingMode = "AUTO";
    itemRow.counterAxisSizingMode = "FIXED";
    itemRow.layoutAlign = "STRETCH";

    if (item.title) {
      const badge = figma.createFrame();
      badge.name = "Title Badge";
      badge.layoutMode = "HORIZONTAL";
      badge.layoutAlign = "MIN";
      badge.paddingTop = 4;
      badge.paddingBottom = 4;
      badge.paddingLeft = 8;
      badge.paddingRight = 8;
      badge.cornerRadius = 4;
      badge.fills = [{ type: 'SOLID', color: hexToRgb(item.color) }];

      const isLightColor = item.color === '#FFCD29';

      const titleText = figma.createText();
      titleText.name = "Title";
      titleText.characters = item.title;
      titleText.fontName = FONT_BOLD;
      titleText.fontSize = 12;
      titleText.fills = [{ type: 'SOLID', color: isLightColor ? { r: 0, g: 0, b: 0 } : { r: 1, g: 1, b: 1 } }];

      badge.appendChild(titleText);
      badge.primaryAxisSizingMode = "AUTO";
      badge.counterAxisSizingMode = "AUTO";
      itemRow.appendChild(badge);
    }

    if (item.desc) {
      const descText = figma.createText();
      descText.name = "Description";
      descText.characters = item.desc;
      descText.fontName = FONT_REGULAR;
      descText.fontSize = 13;
      descText.lineHeight = { value: 20, unit: 'PIXELS' };
      descText.fills = [{ type: 'SOLID', color: hexToRgb('#E6E6E6') }];
      descText.layoutAlign = "STRETCH";
      descText.textAutoResize = "HEIGHT";
      itemRow.appendChild(descText);
    }

    parentFrame.appendChild(itemRow);
  }
}

figma.ui.onmessage = async (msg: { type: string, data?: AnnotationData, message?: string }) => {
  if (msg.type === 'notify' && msg.message) {
    figma.notify(msg.message);
    return;
  }

  if (msg.type === 'create-annotation' && msg.data) {
    const selection = figma.currentPage.selection;
    if (selection.length !== 1) {
      figma.notify("Please select exactly one element to point the annotation to.");
      return;
    }

    const targetNode = selection[0];
    const frame = figma.createFrame();
    frame.name = `${targetNode.name} Annotation`;

    await buildAnnotationContent(frame, msg.data);

    // Save data state
    const payload = { ...msg.data, targetNodeId: targetNode.id };
    frame.setPluginData('annotationData', JSON.stringify(payload));

    // Positioning Logic
    let topParent: BaseNode = targetNode;
    while (topParent.parent && topParent.parent.type !== 'PAGE') {
      topParent = topParent.parent;
    }

    const targetBounds = targetNode.absoluteBoundingBox;
    const parentBounds = 'absoluteBoundingBox' in topParent ? topParent.absoluteBoundingBox : null;

    let targetX = 0;
    let targetY = 0;

    if (targetBounds && parentBounds) {
      targetX = parentBounds.x + parentBounds.width + 120;
      targetY = targetBounds.y;
    } else {
      targetX = targetNode.x + 120;
      targetY = targetNode.y;
    }

    frame.x = targetX;
    frame.y = targetY;

    // Collision detection: Shift down if overlapping with existing annotations
    const existingAnnotations = figma.currentPage.findAllWithCriteria({ pluginData: { keys: ['annotationData'] } }).filter(n => n.id !== frame.id);
    let isOverlapping = true;
    while (isOverlapping) {
      isOverlapping = false;
      for (const existing of existingAnnotations) {
        if ('absoluteBoundingBox' in existing && existing.absoluteBoundingBox) {
          const ez = existing.absoluteBoundingBox;
          const fz = { x: frame.x, y: frame.y, width: frame.width, height: frame.height };

          if (
            fz.x < ez.x + ez.width + 20 &&
            fz.x + fz.width + 20 > ez.x &&
            fz.y < ez.y + ez.height + 20 &&
            fz.y + fz.height + 20 > ez.y
          ) {
            isOverlapping = true;
            frame.y += ez.height + 24; // Shift down by the height of the colliding annotation plus gap
            break;
          }
        }
      }
    }

    figma.currentPage.appendChild(frame);
    updateConnector(frame, payload);

    figma.currentPage.selection = [frame];
  }

  if (msg.type === 'update-annotation' && msg.data) {
    const selection = figma.currentPage.selection;
    if (selection.length !== 1) {
      figma.notify("Lost selection. Please re-select the annotation.");
      return;
    }

    const frame = selection[0];
    if (frame.type !== 'FRAME' || !frame.getPluginData('annotationData')) {
      figma.notify("Selected node is not an editable annotation.");
      return;
    }

    // Retain original targetNodeId
    const existingDataStr = frame.getPluginData('annotationData');
    if (existingDataStr) {
      try {
        const existingData = JSON.parse(existingDataStr);
        if (existingData.targetNodeId) {
          msg.data.targetNodeId = existingData.targetNodeId;
        }
      } catch (e) { }
    }

    await buildAnnotationContent(frame, msg.data);
    frame.setPluginData('annotationData', JSON.stringify(msg.data));
    updateConnector(frame as FrameNode, msg.data);
  }
};
