function toNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized = String(value).replace(/[^0-9.-]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function deriveHoursRemaining(aircraft) {
  const explicit = toNumber(aircraft.hoursRemaining);
  if (explicit !== null) {
    return explicit;
  }

  const nextDue = toNumber(aircraft.next100HourDue);
  const current = toNumber(aircraft.currentTime);
  if (nextDue !== null && current !== null) {
    return Number((nextDue - current).toFixed(1));
  }

  return null;
}

function getStatusColor(hoursRemaining) {
  if (hoursRemaining === null) {
    return "gray";
  }
  if (hoursRemaining < 5) {
    return "red";
  }
  if (hoursRemaining < 10) {
    return "orange";
  }
  if (hoursRemaining <= 20) {
    return "yellow";
  }
  return "green";
}

function buildRecommendations(sortedAircraft) {
  const recommendations = [];
  const mostAvailable = sortedAircraft.find((item) => item.hoursRemaining !== null);
  const constrained = sortedAircraft.filter(
    (item) => item.hoursRemaining !== null && item.hoursRemaining <= 10
  );

  if (mostAvailable) {
    recommendations.push(
      `Aircraft ${mostAvailable.tailNumber} has the most available time and is the best candidate for heavier utilization.`
    );
  }

  constrained.slice(0, 2).forEach((item) => {
    recommendations.push(
      `Aircraft ${item.tailNumber} should be limited or scheduled lighter with ${item.hoursRemaining.toFixed(1)} hours remaining to the next 100-hour inspection.`
    );
  });

  if (constrained.length >= 2) {
    recommendations.push(
      `Two or more aircraft are within 10 hours of inspection; avoid over-scheduling them together.`
    );
  }

  return recommendations;
}

function buildSpacingRisk(sortedAircraft) {
  const active = sortedAircraft.filter((item) => item.hoursRemaining !== null);
  const warnings = [];

  for (let index = 0; index < active.length - 1; index += 1) {
    const current = active[index];
    const next = active[index + 1];
    const gap = Math.abs(current.hoursRemaining - next.hoursRemaining);

    if (gap <= 5) {
      warnings.push({
        level: "high",
        message: `${current.tailNumber} and ${next.tailNumber} are projected to hit 100-hour inspections within ${gap.toFixed(1)} hours of each other.`
      });
    } else if (gap <= 10) {
      warnings.push({
        level: "medium",
        message: `${current.tailNumber} and ${next.tailNumber} are trending close together, only ${gap.toFixed(1)} hours apart.`
      });
    }
  }

  return warnings;
}

function analyzeAircraft(rawAircraft = []) {
  const aircraft = rawAircraft.map((entry) => {
    const hoursRemaining = deriveHoursRemaining(entry);

    return {
      ...entry,
      currentTime: toNumber(entry.currentTime),
      last100Hour: toNumber(entry.last100Hour),
      next100HourDue: toNumber(entry.next100HourDue),
      hoursRemaining,
      statusColor: getStatusColor(hoursRemaining),
      isOverdue: hoursRemaining !== null && hoursRemaining < 0
    };
  });

  const sortedAircraft = [...aircraft].sort((left, right) => {
    if (left.hoursRemaining === null) {
      return 1;
    }
    if (right.hoursRemaining === null) {
      return -1;
    }
    return left.hoursRemaining - right.hoursRemaining;
  });

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      aircraft: aircraft.length,
      overdue: aircraft.filter((item) => item.isOverdue).length,
      critical: aircraft.filter(
        (item) => item.hoursRemaining !== null && item.hoursRemaining < 5
      ).length
    },
    spacingRisk: buildSpacingRisk(sortedAircraft),
    recommendations: buildRecommendations(sortedAircraft),
    aircraft: sortedAircraft
  };
}

module.exports = {
  analyzeAircraft
};
