import {DataComponentCompiler} from './base';

import {autoMaxBins, Bin} from '../../bin';
import {Channel} from '../../channel';
import {field, FieldDef} from '../../fielddef';
import {extend, vals, flatten, isBoolean, Dict} from '../../util';
import {VgTransform} from '../../vega.schema';
import {hasDiscreteDomain} from '../../scale';

import {FacetModel} from './../facet';
import {LayerModel} from './../layer';
import {Model} from './../model';


function numberFormatExpr(expr: string, format: string) {
  return `format(${expr}, '${format}')`;
}

function addRangeFormula(model: Model, transform: VgTransform[], fieldDef: FieldDef, channel: Channel) {
  if (transform.length > 0 && transform[transform.length - 1].type !== 'formula') {
    const hasDiscreteDomainOrHasLegend = hasDiscreteDomain(model.scale(channel).type) || model.legend(channel);
    if (hasDiscreteDomainOrHasLegend) {
      // read format from axis or legend, if there is no format then use config.numberFormat
      const format = (model.axis(channel) || model.legend(channel) || {}).format ||
        model.config.numberFormat;

      const startField = field(fieldDef, {datum: true, binSuffix: 'start'});
      const endField = field(fieldDef, {datum: true, binSuffix: 'end'});

      transform.push({
        type: 'formula',
        as: field(fieldDef, {binSuffix: 'range'}),
        expr: `${numberFormatExpr(startField, format)} + ' - ' + ${numberFormatExpr(endField, format)}`
      });
    }
  }
}

function parse(model: Model): Dict<VgTransform[]> {
  return model.reduceFieldDef(function(binComponent: Dict<VgTransform[]>, fieldDef: FieldDef, channel: Channel) {
    const fieldDefBin = model.fieldDef(channel).bin;
    if (fieldDefBin) {
      const bin: Bin = isBoolean(fieldDefBin) ? {} : {...fieldDefBin};
      if (!bin.maxbins && !bin.steps) {
        bin.maxbins = autoMaxBins(channel);
      }
      let keyFromBin = '';
      for (const property in bin) {
        if (bin[property]) {
          keyFromBin += property + '_' + bin[property] + '_';
        }
      }
      const key = keyFromBin + '_' + fieldDef.field;
      if (!binComponent[key]) {
        const transform: VgTransform[] = [];
        const extentSignal = model.getName(key + '_extent');
        const binTrans: VgTransform = {
          ...{
            type: 'bin',
            field: fieldDef.field,
            as: [field(fieldDef, {binSuffix: 'start'}), field(fieldDef, {binSuffix: 'end'})]
          },
          ...bin,
          // add extent if it's not specified
          ...(!bin.extent ? {extent: {signal: extentSignal}} : {})
        };
        if (!bin.extent) {
          transform.push({
            type: 'extent',
            field: fieldDef.field,
            signal: extentSignal
          });
        }
        transform.push(binTrans);
        binComponent[key] = transform;
      }
      addRangeFormula(model, binComponent[key], fieldDef, channel);
    }
    return binComponent;
  }, {});
}

export const bin: DataComponentCompiler<Dict<VgTransform[]>> = {
  parseUnit: parse,

  parseFacet: function(model: FacetModel) {
    let binComponent = parse(model);

    const childDataComponent = model.child.component.data;

    // If child doesn't have its own data source, then merge
    if (!childDataComponent.source) {
      // FIXME: current merging logic can produce redundant transforms when a field is binned for color and for non-color
      extend(binComponent, childDataComponent.bin);
      delete childDataComponent.bin;
    }
    return binComponent;
  },

  parseLayer: function (model: LayerModel) {
    let binComponent = parse(model);

    model.children.forEach((child) => {
      const childDataComponent = child.component.data;

      // If child doesn't have its own data source, then merge
      if (!childDataComponent.source) {
        extend(binComponent, childDataComponent.bin);
        delete childDataComponent.bin;
      }
    });

    return binComponent;
  },

  assemble: function (component: Dict<VgTransform[]>) {
    return flatten(vals(component));
  }
};
