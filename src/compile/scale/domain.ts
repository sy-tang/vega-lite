import * as log from '../../log';

import {SHARED_DOMAIN_OPS} from '../../aggregate';
import {Channel} from '../../channel';
import {SOURCE} from '../../data';
import {DateTime, isDateTime, timestamp} from '../../datetime';
import {Domain, Scale, ScaleType, hasDiscreteDomain, ScaleConfig} from '../../scale';
import {isSortField} from '../../sort';
import {FieldRefUnionDomain, VgSortField, isDataRefUnionedDomain, isFieldRefUnionDomain, isDataRefDomain, VgDomain, VgDataRef} from '../../vega.schema';

import * as util from '../../util';

import {Model} from '../model';
import {FieldDef} from '../../fielddef';


export function initDomain(domain: Domain, fieldDef: FieldDef, scale: ScaleType, scaleConfig: ScaleConfig) {
  if (domain === 'unaggregated') {
    const {valid, reason} = canUseUnaggregatedDomain(fieldDef, scale);
    if(!valid) {
      log.warn(reason);
      return undefined;
    }
  } else if (domain === undefined && scaleConfig.useUnaggregatedDomain) {
    // Apply config if domain is not specified.
    const {valid} = canUseUnaggregatedDomain(fieldDef, scale);
    if (valid) {
      return 'unaggregated';
    }
  }

  return domain;
}


export function parseDomain(model: Model, channel: Channel): VgDomain {
  const scale = model.scale(channel);


  // If channel is either X or Y then union them with X2 & Y2 if they exist
  if (channel === 'x' && model.channelHasField('x2')) {
    if (model.channelHasField('x')) {
      return unionDomains(parseSingleChannelDomain(scale, model, 'x'), parseSingleChannelDomain(scale, model, 'x2'));
    } else {
      return parseSingleChannelDomain(scale, model, 'x2');
    }
  } else if (channel === 'y' && model.channelHasField('y2')) {
    if (model.channelHasField('y')) {
      return unionDomains(parseSingleChannelDomain(scale, model, 'y'), parseSingleChannelDomain(scale, model, 'y2'));
    } else {
      return parseSingleChannelDomain(scale, model, 'y2');
    }
  }
  return parseSingleChannelDomain(scale, model, channel);
}

function parseSingleChannelDomain(scale: Scale, model: Model, channel:Channel): any[] | VgDataRef | FieldRefUnionDomain {
  const fieldDef = model.fieldDef(channel);

  if (scale.domain && scale.domain !== 'unaggregated') { // explicit value
    if (isDateTime(scale.domain[0])) {
      return (scale.domain as DateTime[]).map((dt) => {
        return timestamp(dt, true);
      });
    }
    return scale.domain;
  }

  // special case for temporal scale
  if (fieldDef.type === 'temporal') {
    return {
      data: model.dataTable(),
      field: model.field(channel),
      sort: {
        field: model.field(channel),
        op: 'min'
      }
    };
  }

  // For stack, use STACKED data.
  const stack = model.stack;
  if (stack && channel === stack.fieldChannel) {
    if(stack.offset === 'normalize') {
      return [0, 1];
    }
    return {
      data: model.dataName('stacked'),
      fields: [
        model.field(channel, {suffix: 'start'}),
        model.field(channel, {suffix: 'end'})
      ]
    };
  }

  const sort = domainSort(model, channel, scale.type);

  if (scale.domain === 'unaggregated') {
    return {
      data: model.dataTable(),
      fields: [
        model.field(channel, {aggregate: 'min'}),
        model.field(channel, {aggregate: 'max'})
      ]
    };
  } else if (fieldDef.bin) { // bin
    if (hasDiscreteDomain(scale.type)) {
      // ordinal bin scale takes domain from bin_range, ordered by bin_start
      // This is useful for both axis-based scale (x, y, column, and row) and legend-based scale (other channels).
      return {
        data: model.dataTable(),
        field: model.field(channel, {binSuffix: 'range'}),
        sort: {
          field: model.field(channel, {binSuffix: 'start'}),
          op: 'min' // min or max doesn't matter since same _range would have the same _start
        }
      };
    } else { // continuous scales
      if (channel === 'x' || channel === 'y') {
        // X/Y position have to include start and end for non-ordinal scale
        return {
          data: model.dataTable(),
          fields: [
            model.field(channel, {binSuffix: 'start'}),
            model.field(channel, {binSuffix: 'end'})
          ]
        };
      } else {
        // TODO: use bin_mid
        return {
          data: model.dataTable(),
          field: model.field(channel, {binSuffix: 'start'})
        };
      }
    }
  } else if (sort) { // have sort -- only for ordinal
    return {
      // If sort by aggregation of a specified sort field, we need to use SOURCE table,
      // so we can aggregate values for the scale independently from the main aggregation.
      data: util.isBoolean(sort) ? model.dataTable(): SOURCE,
      field: model.field(channel),
      sort: sort
    };
  } else {
    return {
      data: model.dataTable(),
      field: model.field(channel),
    };
  }
}

export function domainSort(model: Model, channel: Channel, scaleType: ScaleType): VgSortField {
  if (!hasDiscreteDomain(scaleType)) {
    return undefined;
  }

  const sort = model.sort(channel);

  // Sorted based on an aggregate calculation over a specified sort field (only for ordinal scale)
  if (isSortField(sort)) {
    return {
      op: sort.op,
      field: sort.field
    };
  }

  if (util.contains(['ascending', 'descending', undefined /* default =ascending*/], sort)) {
    return true;
  }

  // sort === 'none'
  return undefined;
}



/**
 * Determine if a scale can use unaggregated domain.
 * @return {Boolean} Returns true if all of the following conditons applies:
 * 1. `scale.domain` is `unaggregated`
 * 2. Aggregation function is not `count` or `sum`
 * 3. The scale is quantitative or time scale.
 */
export function canUseUnaggregatedDomain(fieldDef: FieldDef, scaleType: ScaleType): {valid: boolean, reason?: string} {
  if (!fieldDef.aggregate) {
    return {
      valid: false,
      reason: log.message.unaggregateDomainHasNoEffectForRawField(fieldDef)
    };
  }

  if (SHARED_DOMAIN_OPS.indexOf(fieldDef.aggregate) === -1) {
    return {
      valid: false,
      reason: log.message.unaggregateDomainWithNonSharedDomainOp(fieldDef.aggregate)
    };
  }

  if (fieldDef.type === 'quantitative') {
    if (scaleType === 'log') {
      return {
        valid: false,
        reason: log.message.unaggregatedDomainWithLogScale(fieldDef)
      };
    }
  }

  return {valid: true};
}


/**
 * Convert the domain to an array of data refs or an array of values. Also, throw
 * away sorting information since we always sort the domain when we union two domains.
 */
function normalizeDomain(domain: VgDomain): (any[] | VgDataRef)[] {
  if (util.isArray(domain)) {
    return [domain];
  } else if (isDataRefDomain(domain)) {
    delete domain.sort;
    return [domain];
  } else if(isFieldRefUnionDomain(domain)) {
    return domain.fields.map(d => {
      return {
        data: domain.data,
        field: d
      };
    });
  } else if (isDataRefUnionedDomain(domain)) {
    return domain.fields.map(d => {
      if (util.isArray(d)) {
        return d;
      }
      return {
        field: d.field,
        data: d.data
      };
    });
  }
  /* istanbul ignore next: This should never happen. */
  throw new Error(log.message.INVAID_DOMAIN);
}

/**
 * Union two data domains. A unioned domain is always sorted.
 */
export function unionDomains(domain1: VgDomain, domain2: VgDomain): VgDomain {
  const normalizedDomain1 = normalizeDomain(domain1);
  const normalizedDomain2 = normalizeDomain(domain2);

  let domains = normalizedDomain1.concat(normalizedDomain2);
  domains = util.unique(domains, util.hash);

  if (domains.length > 1) {
    const allData = domains.map(d => {
      if (isDataRefDomain(d)) {
        return d.data;
      }
      return null;
    });

    if (util.unique(allData, x => x).length === 1 && allData[0] !== null) {
      return {
        data: allData[0],
        fields: domains.map(d => (d as VgDataRef).field)
      };
    }

    return {fields: domains, sort: true};
  } else {
    return domains[0];
  }
}
